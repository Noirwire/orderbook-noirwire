import { expect } from "chai";
import { Keypair, PACKET_DATA_SIZE, PublicKey } from "@solana/web3.js";
import {
  Instructions,
  MAX_FIRES_PER_PASS,
  MAX_PERP_MARKETS,
  MAX_SEATS,
  MIN_SEATS,
  ROLE,
  SWEEP_TRIGGER_SLOTS_PER_CALL,
  TRIGGER_ERROR,
  TRIGGER_FLAG,
  TRIGGER_KIND,
  TRIGGER_RESULT_KIND,
  TRIGGER_TRANSACTION_ERROR,
  Writer,
  decodeTriggerBook,
  ownFills,
  receipt,
  replaceKeysSignedTransaction,
  triggerAccountLen,
} from "../sdk/dist/index.js";
import { decodeArgs, errorCode, idl } from "./idl";

const key = (fill: number) => new PublicKey(new Uint8Array(32).fill(fill));
const instructions = new Instructions(new PublicKey(idl.address));
const addresses = instructions.addresses;

const use = {
  orderKey: key(10),
  owner: key(11),
  expiresAt: 5n,
  replacement: key(12),
  clientOrderId: 9n,
  marketId: 1,
};

const flags = (instruction: {
  keys: { isSigner: boolean; isWritable: boolean }[];
}) =>
  instruction.keys.map(
    (account) =>
      `${account.isSigner ? "s" : "-"}${account.isWritable ? "w" : "-"}`,
  );

describe("the client's trigger support", () => {
  describe("the trigger book's address", () => {
    it("is derived from the seed `trigger` and the market id, one per market", () => {
      for (const marketId of [0, 1, 7]) {
        expect(addresses.triggers(marketId).toBase58()).to.equal(
          PublicKey.findProgramAddressSync(
            [Buffer.from("trigger"), Buffer.from([marketId])],
            new PublicKey(idl.address),
          )[0].toBase58(),
        );
      }
      expect(addresses.triggers(0).equals(addresses.triggers(1))).to.equal(
        false,
      );
      expect(addresses.triggers(1).equals(addresses.tape(1))).to.equal(false);
    });
  });

  describe("the constants", () => {
    it("name the program's errors and results by number", () => {
      const named = Object.entries({
        bookInvalid: "TriggerBookInvalid",
        bookTooSmall: "TriggerBookTooSmall",
        slotRetired: "TriggerSlotRetired",
        sizeBelowMinimum: "TriggerSizeBelowMinimum",
        priceInvalid: "TriggerPriceInvalid",
        wouldFireImmediately: "TriggerWouldFireImmediately",
        worstPriceInvalid: "TriggerWorstPriceInvalid",
        sizeInvalid: "TriggerSizeInvalid",
        expiryInvalid: "TriggerExpiryInvalid",
        pairCrossed: "TriggerPairCrossed",
        kindInvalid: "TriggerKindInvalid",
      }) as [keyof typeof TRIGGER_ERROR, string][];
      expect(named).to.have.length(Object.keys(TRIGGER_ERROR).length);
      for (const [name, programName] of named) {
        expect(TRIGGER_TRANSACTION_ERROR[name], programName).to.equal(
          errorCode(programName),
        );
        expect(TRIGGER_ERROR[name], programName).to.equal(
          errorCode(programName) - 6000,
        );
      }
      expect(TRIGGER_RESULT_KIND).to.deep.equal({
        setTrigger: 10,
        cancelTrigger: 11,
      });
      expect(TRIGGER_KIND).to.deep.equal({ takeProfit: 0, stopLoss: 1 });
      expect(MAX_FIRES_PER_PASS).to.equal(32);
      expect(SWEEP_TRIGGER_SLOTS_PER_CALL).to.equal(2048);
    });

    it("size a trigger book as the design says: 56 bytes and 208 for each seat", () => {
      expect(triggerAccountLen(0)).to.equal(56);
      expect(triggerAccountLen(MIN_SEATS)).to.equal(426_040);
      expect(triggerAccountLen(MAX_SEATS)).to.equal(7_174_392);
    });
  });

  describe("the instruction builders", () => {
    it("encode set_trigger's parameters in the program's order, and leave the expiry at zero by default", () => {
      const trigger = {
        kind: TRIGGER_KIND.takeProfit,
        triggerPrice: 1_100n,
        worstPrice: 1_050n,
        size: 7n,
        expiry: 1_900_000_000n,
        secret: new Uint8Array(16).map((_, at) => at + 1),
      };
      const set = instructions.setTrigger(use, trigger);
      expect(decodeArgs("set_trigger", set.data)).to.deep.equal({
        args: {
          expires_at: 5n,
          replacement: new Uint8Array(32).fill(12),
          client_order_id: 9n,
          market_id: 1,
          trigger: {
            kind: 0,
            trigger_price: 1_100n,
            worst_price: 1_050n,
            size: 7n,
            expiry: 1_900_000_000n,
            secret: Array.from(trigger.secret),
          },
        },
        exact: true,
      });
      expect(set.data.subarray(-16)).to.deep.equal(Buffer.from(trigger.secret));
      const { expiry: _, ...withoutExpiry } = trigger;
      const never = decodeArgs(
        "set_trigger",
        instructions.setTrigger(use, withoutExpiry).data,
      ).args.trigger as { expiry: bigint };
      expect(never.expiry).to.equal(0n);
    });

    it("encode cancel_trigger, fire_triggers, sweep_triggers and the two book steps", () => {
      expect(
        decodeArgs(
          "cancel_trigger",
          instructions.cancelTrigger(use, TRIGGER_KIND.stopLoss).data,
        ),
      ).to.deep.equal({
        args: {
          expires_at: 5n,
          replacement: new Uint8Array(32).fill(12),
          client_order_id: 9n,
          market_id: 1,
          kind: 1,
        },
        exact: true,
      });
      expect(
        decodeArgs("fire_triggers", instructions.fireTriggers(3, 17).data),
      ).to.deep.equal({ args: { market_id: 3, max_fires: 17 }, exact: true });
      expect(
        decodeArgs("sweep_triggers", instructions.sweepTriggers(3, 300).data),
      ).to.deep.equal({ args: { market_id: 3, count: 300 }, exact: true });
      for (const name of ["create_trigger_book", "finalize_trigger_book"]) {
        const build =
          name === "create_trigger_book"
            ? instructions.createTriggerBook(key(1), 4)
            : instructions.finalizeTriggerBook(key(1), 4);
        expect(decodeArgs(name, build.data)).to.deep.equal({
          args: { market_id: 4 },
          exact: true,
        });
      }
    });

    it("name the trigger book after the stats account and before the risk accounts in every order-key instruction", () => {
      const call = { ...use, riskMarkets: [1, 2, 5] };
      const sample = {
        side: 0,
        orderType: 0,
        price: 1n,
        size: 1n,
        secret: new Uint8Array(16),
        reduceOnly: false,
      };
      const built = {
        place_order: instructions.placeOrder(call, sample),
        cancel_order: instructions.cancelOrder(call, 1n),
        cancel_all: instructions.cancelAll(call, 1),
        sync_view: instructions.syncView(call),
        liquidate: instructions.liquidate(call, 2, 1n, 1n),
        liquidate_range: instructions.liquidateRange(call, {
          start: 2,
          count: 1,
          size: 1n,
          worstPrice: 1n,
          maxTakeovers: 1,
        }),
        transfer_between_balances: instructions.transferBetweenBalances(
          call,
          true,
          0,
          1n,
        ),
        set_trigger: instructions.setTrigger(call, {
          kind: 0,
          triggerPrice: 1n,
          worstPrice: 1n,
          size: 0n,
          secret: new Uint8Array(16),
        }),
        cancel_trigger: instructions.cancelTrigger(call, 0),
      };
      for (const [name, instruction] of Object.entries(built)) {
        const declared = idl.instructions.find((each) => each.name === name)!;
        expect(
          declared.accounts.map(({ name: account }) => account),
          name,
        ).to.deep.equal([
          "order_key",
          "view",
          "exchange",
          "ledger",
          "market",
          "book",
          "price_feed",
          "tape",
          "stats",
          "triggers",
        ]);
        expect(instruction.keys[9].pubkey.toBase58(), name).to.equal(
          addresses.triggers(1).toBase58(),
        );
        expect(flags({ keys: [instruction.keys[9]] }), name).to.deep.equal([
          "-w",
        ]);
        expect(
          instruction.keys.slice(10).map(({ pubkey }) => pubkey.toBase58()),
          name,
        ).to.deep.equal(
          [2, 5].flatMap((id) =>
            addresses.riskAccounts(id).map((account) => account.toBase58()),
          ),
        );
      }
    });

    it("name every instruction of the interface file that takes a trigger book, and nothing else does", () => {
      const takers = idl.instructions
        .filter(({ accounts }) =>
          accounts.some(({ name }) => name === "triggers"),
        )
        .map(({ name }) => name)
        .sort();
      expect(takers).to.deep.equal([
        "cancel_all",
        "cancel_order",
        "cancel_trigger",
        "create_trigger_book",
        "finalize_trigger_book",
        "fire_triggers",
        "liquidate",
        "liquidate_range",
        "place_order",
        "set_trigger",
        "sweep_triggers",
        "sync_view",
        "transfer_between_balances",
      ]);
    });

    it("send fire_triggers with no signer and the risk accounts of the other perp markets, and sweep_triggers with the ledger read-only", () => {
      const fire = instructions.fireTriggers(2, 4, [0, 2, 3]);
      expect(fire.keys.some(({ isSigner }) => isSigner)).to.equal(false);
      expect(fire.keys[7].pubkey.toBase58()).to.equal(
        addresses.triggers(2).toBase58(),
      );
      expect(
        fire.keys.slice(8).map(({ pubkey }) => pubkey.toBase58()),
      ).to.deep.equal(
        [0, 3].flatMap((id) =>
          addresses.riskAccounts(id).map((account) => account.toBase58()),
        ),
      );
      expect(flags(instructions.sweepTriggers(2, 1))).to.deep.equal([
        "--",
        "--",
        "-w",
      ]);
    });

    it("hand set_order_keys and set_order_keys_signed every perp market's trigger book, writable, after the interface file's accounts", () => {
      const owner = key(21);
      const keys = [31, 32, 33, 34].map(key);
      const perp = [0, 2, 6];
      const books = perp.map((id) => addresses.triggers(id).toBase58());
      const plain = instructions.setOrderKeys(owner, keys, perp);
      const signed = instructions.setOrderKeysSigned(owner, keys, 3, 99n, perp);
      for (const [name, instruction] of [
        ["set_order_keys", plain],
        ["set_order_keys_signed", signed],
      ] as const) {
        const declared = idl.instructions.find((each) => each.name === name)!;
        expect(
          flags({ keys: instruction.keys.slice(0, declared.accounts.length) }),
          name,
        ).to.deep.equal(
          declared.accounts.map(
            ({ signer, writable }) =>
              `${signer ? "s" : "-"}${writable ? "w" : "-"}`,
          ),
        );
        const rest = instruction.keys.slice(declared.accounts.length);
        expect(
          rest.map(({ pubkey }) => pubkey.toBase58()),
          name,
        ).to.deep.equal(books);
        expect(flags({ keys: rest }), name).to.deep.equal(["-w", "-w", "-w"]);
        expect(
          instruction.keys
            .slice(0, declared.accounts.length)
            .map(({ pubkey }) => pubkey.toBase58()),
          name,
        ).to.include.members([
          addresses.exchange.toBase58(),
          addresses.ledger.toBase58(),
        ]);
      }
      expect(decodeArgs("set_order_keys_signed", signed.data).exact).to.equal(
        true,
      );
    });

    it("fit one packet, with the proof, when a signed key replacement names the most perp markets", async () => {
      const owner = Keypair.generate();
      const payer = Keypair.generate();
      const perpMarkets = Array.from(
        { length: MAX_PERP_MARKETS },
        (_, id) => id,
      );
      const connection = {
        getLatestBlockhash: async () => ({
          blockhash: PublicKey.default.toBase58(),
          lastValidBlockHeight: 1,
        }),
      };
      const sizes: number[] = [];
      for (let named = 0; named <= MAX_PERP_MARKETS; named += 1) {
        const { raw } = await replaceKeysSignedTransaction(
          connection as never,
          instructions,
          payer,
          {
            owner: owner.publicKey,
            orderKeys: [31, 32, 33, 34].map(key),
            nonce: 0xffffffff,
            expiresAt: 1_800_000_000n,
            signature: new Uint8Array(64).fill(7),
            perpMarkets: perpMarkets.slice(0, named),
          },
        );
        sizes.push(raw.length);
      }
      console.log("set_order_keys_signed bytes by perp markets named", sizes);
      expect(sizes.at(-1)).to.be.at.most(PACKET_DATA_SIZE);
    });
  });

  describe("the trigger book decoder", () => {
    const TAG = "nwtrig\0\0";

    const record = (
      writer: Writer,
      fields: Partial<{
        triggerPrice: bigint;
        worstPrice: bigint;
        size: bigint;
        clientId: bigint;
        expiry: bigint;
        nextAttempt: bigint;
        recordVersion: number;
        position: number;
        flags: number;
        generation: number;
        perpSlot: number;
        heap: number;
        sequence: number;
        secret: Uint8Array;
      }> = {},
    ) =>
      writer
        .u64(fields.triggerPrice ?? 0n)
        .u64(fields.worstPrice ?? 0n)
        .u64(fields.size ?? 0n)
        .u64(fields.clientId ?? 0n)
        .i64(fields.expiry ?? 0n)
        .i64(fields.nextAttempt ?? 0n)
        .u32(fields.recordVersion ?? 0)
        .u32(fields.position ?? 0)
        .u8(fields.flags ?? 0)
        .u8(fields.generation ?? 0)
        .u8(fields.perpSlot ?? 0)
        .u8(fields.heap ?? 0)
        .u32(fields.sequence ?? 0)
        .bytes(fields.secret ?? new Uint8Array(16));

    const book = (seats: number, fill: (writer: Writer) => void) => {
      const writer = new Writer()
        .bytes(new TextEncoder().encode(TAG))
        .bool(true)
        .u8(3)
        .u8(250)
        .bytes(new Uint8Array(5))
        .u32(1)
        .u32(3)
        .u32(seats)
        .u32(2)
        .u32(0)
        .u32(1)
        .u32(11)
        .u32(5)
        .u32(8)
        .u32(0);
      fill(writer);
      return writer.bytes(new Uint8Array(16 * seats)).build();
    };

    const takeProfitSecret = new Uint8Array(16).map((_, at) => 0xa0 + at);
    const stopLossSecret = new Uint8Array(16).fill(0x5c);

    const slots = (writer: Writer) => {
      writer.bytes(new Uint8Array(32));
      record(writer);
      record(writer);
      writer.pubkey(key(9));
      record(writer, {
        triggerPrice: 1_100n,
        worstPrice: 1_000n,
        size: 5n,
        clientId: 42n,
        expiry: 1_900_000_000n,
        nextAttempt: 33n,
        recordVersion: 6,
        position: 1,
        flags:
          TRIGGER_FLAG.active | TRIGGER_FLAG.wholePosition | TRIGGER_FLAG.long,
        generation: 2,
        perpSlot: 1,
        heap: 1,
        sequence: 10,
        secret: takeProfitSecret,
      });
      record(writer, {
        triggerPrice: 800n,
        worstPrice: 790n,
        recordVersion: 7,
        flags:
          TRIGGER_FLAG.active |
          TRIGGER_FLAG.firesBelow |
          TRIGGER_FLAG.unfillable,
        heap: 2,
        secret: stopLossSecret,
      });
      writer.bytes(new Uint8Array(32));
      record(writer);
      record(writer);
    };

    it("reads the headers, the cursors and every seat's slot with both records and their flags", () => {
      const decoded = decodeTriggerBook(book(3, slots));
      expect(decoded.header).to.deep.equal({
        tag: TAG,
        ready: true,
        marketId: 3,
        bump: 250,
      });
      expect(decoded).to.include({
        version: 1,
        bookMarketId: 3,
        seatCapacity: 3,
        nextSequence: 11,
        sweepCursor: 5,
        fairCursor: 8,
      });
      expect(decoded.heapLen).to.deep.equal([2, 0, 1]);
      expect(decoded.slots).to.have.length(3);
      expect(decoded.slots[0].owner).to.equal(null);
      expect(decoded.slots[2].owner).to.equal(null);
      const held = decoded.slots[1];
      expect(held.owner!.equals(key(9))).to.equal(true);
      expect(held.takeProfit).to.include({
        triggerPrice: 1_100n,
        worstPrice: 1_000n,
        size: 5n,
        clientId: 42n,
        expiry: 1_900_000_000n,
        nextAttempt: 33n,
        recordVersion: 6,
        heapPosition: 1,
        generation: 2,
        perpSlot: 1,
        heap: 1,
        sequence: 10,
        active: true,
        wholePosition: true,
        long: true,
        firesBelow: false,
        unfillable: false,
      });
      expect(held.stopLoss).to.include({
        triggerPrice: 800n,
        recordVersion: 7,
        active: true,
        firesBelow: true,
        unfillable: true,
        wholePosition: false,
        long: false,
      });
      expect(held.takeProfit.secret).to.deep.equal(takeProfitSecret);
      expect(held.stopLoss.secret).to.deep.equal(stopLossSecret);
      expect(decoded.slots[0].takeProfit.active).to.equal(false);
      expect(decoded.slots[0].takeProfit.secret).to.deep.equal(
        new Uint8Array(16),
      );
    });

    it("hands back the secret whose receipts a fired order's fills carry on the tape", () => {
      const { secret } = decodeTriggerBook(book(3, slots)).slots[1].takeProfit;
      const fillSeq = 41n;
      const fill = {
        fillSeq,
        price: 1_100n,
        size: 5n,
        time: 1_800_000_000n,
        makerReceipt: new Uint8Array(8).fill(1),
        takerReceipt: receipt(secret, fillSeq, ROLE.taker),
        takerSide: 1,
      };
      const other = { ...fill, fillSeq: 42n, takerReceipt: new Uint8Array(8) };
      const own = ownFills([fill, other], [secret]);
      expect(own).to.have.length(1);
      expect(own[0].role).to.equal("taker");
      expect(own[0].fill.fillSeq).to.equal(fillSeq);
      expect(
        ownFills(
          [fill],
          [decodeTriggerBook(book(3, slots)).slots[1].stopLoss.secret],
        ),
      ).to.deep.equal([]);
    });

    it("reads a spot market's book, which is its headers alone", () => {
      const decoded = decodeTriggerBook(book(0, () => {}));
      expect(decoded.seatCapacity).to.equal(0);
      expect(decoded.slots).to.deep.equal([]);
    });

    it("refuses another account, and a length that is not the one its seat capacity asks for", () => {
      const good = book(3, slots);
      expect(good.length).to.equal(triggerAccountLen(3));
      const other = Buffer.from(good);
      other.write("nwtape\0\0", 0, "latin1");
      expect(() => decodeTriggerBook(other)).to.throw(/nwtrig/);
      expect(() =>
        decodeTriggerBook(good.subarray(0, good.length - 1)),
      ).to.throw(/expected 680 bytes/);
      expect(() =>
        decodeTriggerBook(Buffer.concat([good, Buffer.alloc(8)])),
      ).to.throw(/expected 680 bytes/);
    });
  });
});
