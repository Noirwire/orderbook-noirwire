import { expect } from "chai";
import {
  Keypair,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import { ORDER_TYPE, OrderKeyManager, SIDE } from "../../sdk/dist/index.js";
import {
  addresses,
  admin,
  instructions,
  ledgerThroughThePort,
  rollup,
  rollupNow,
  send,
} from "../support";
import { handsOverItsAdminRole } from "./admin-hand-over";
import {
  MARK,
  NEVER_CREATED,
  NUSD,
  PERP,
  SEATS_PER_DAY,
  SEAT_CLOSED,
  SECONDS_PER_DAY,
  SPOT,
  TRADER_RENT,
  UNFINISHED,
  attempted,
  call,
  cast,
  custodyMatchesLedger,
  deposited,
  exchangeBalance,
  exchangeOn,
  fundedWith,
  gate,
  limits,
  mints,
  newOrderKeys,
  openedTrader,
  order,
  orderKeySeed,
  placing,
  refuses,
  settings,
  soon,
  spotMarket,
  stranger,
  tokenAccount,
  type Trader,
} from "./world";

/** `instruction` with the signer it names first swapped for another key. */
const signedInsteadBy = (
  instruction: TransactionInstruction,
  pubkey: PublicKey,
) => {
  instruction.keys[0] = { ...instruction.keys[0], pubkey };
  return instruction;
};

const VIEW_OF_A_WITHDRAWAL = 3;

const withdrawal = (
  trader: Trader,
  amount = 1n,
  owner = trader.owner.publicKey,
) =>
  instructions.withdraw(
    owner,
    tokenAccount(trader, mints.nUSD),
    mints.nUSD,
    { spot: NUSD },
    amount,
    [PERP],
  );

describe("authority", () => {
  it("refuses every instruction for the wrong signer", async () => {
    const { alice, bob, carol } = cast;
    const forger = alice.keys.take();
    const forged = {
      ...call(alice, forger, SPOT, 11n, soon()),
      owner: bob.owner.publicKey,
    };
    const probe = alice.keys.take();
    const table: [string, TransactionInstruction, Keypair, string][] = [
      [
        "update_exchange",
        instructions.updateExchange(stranger.publicKey, settings()),
        stranger,
        "NotAdmin",
      ],
      [
        "set_paused",
        instructions.setPaused(stranger.publicKey, true),
        stranger,
        "NotAdmin",
      ],
      [
        "create_market",
        instructions.createMarket(
          stranger.publicKey,
          NEVER_CREATED,
          spotMarket(),
        ),
        stranger,
        "NotAdmin",
      ],
      [
        "finalize_market",
        instructions.finalizeMarket(stranger.publicKey, UNFINISHED),
        stranger,
        "NotAdmin",
      ],
      [
        "finalize_ledger",
        instructions.finalizeLedger(stranger.publicKey),
        stranger,
        "NotAdmin",
      ],
      [
        "create_ledger",
        instructions.createLedger(stranger.publicKey),
        stranger,
        "NotAdmin",
      ],
      [
        "undelegate_exchange",
        instructions.undelegateExchange(stranger.publicKey),
        stranger,
        "NotAdmin",
      ],
      [
        "set_order_keys by a stranger with the owner's view",
        signedInsteadBy(
          instructions.setOrderKeys(
            alice.owner.publicKey,
            alice.keys.publicKeys,
          ),
          stranger.publicKey,
        ),
        stranger,
        "ConstraintSeeds",
      ],
      [
        "close_trader by a stranger with the owner's view",
        signedInsteadBy(
          instructions.closeTrader(alice.owner.publicKey),
          stranger.publicKey,
        ),
        stranger,
        "ConstraintSeeds",
      ],
      [
        "withdraw by an order key",
        signedInsteadBy(withdrawal(alice), probe.keypair.publicKey),
        probe.keypair,
        "ConstraintSeeds",
      ],
      [
        "place_order with another owner's view",
        instructions.placeOrder(
          forged,
          order(SIDE.bid, ORDER_TYPE.immediateOrCancel, MARK, 10n),
        ),
        forger.keypair,
        "NotOrderKey",
      ],
      [
        "liquidate by a non-key",
        instructions.liquidate(
          {
            ...forged,
            owner: carol.owner.publicKey,
            orderKey: stranger.publicKey,
          },
          bob.seat,
          1n,
          1n,
        ),
        stranger,
        "NotOrderKey",
      ],
      [
        "cancel_all by the owner",
        instructions.cancelAll(
          {
            ...forged,
            owner: alice.owner.publicKey,
            orderKey: alice.owner.publicKey,
          },
          1,
        ),
        alice.owner,
        "NotOrderKey",
      ],
    ];
    for (const [what, instruction, signer, error] of table) {
      await refuses(send(rollup, instruction, signer), error, what);
    }
    const view = await alice.client.view();
    alice.keys.release(forger, view);
    alice.keys.release(probe, view);
  });

  it("refuses to impersonate an owner through a view at the wrong derivation", async () => {
    const { alice } = cast;
    const impostor = withdrawal(alice, 1n, stranger.publicKey);
    impostor.keys[VIEW_OF_A_WITHDRAWAL] = {
      ...impostor.keys[VIEW_OF_A_WITHDRAWAL],
      pubkey: addresses.view(alice.owner.publicKey),
    };
    await refuses(send(rollup, impostor, stranger), "ConstraintSeeds");
  });

  it("refuses orders and liquidations while paused, by the admin's hand only, and still cancels", async () => {
    const { alice } = cast;
    await send(rollup, instructions.setPaused(admin.publicKey, true), admin);
    const paused = placing(
      alice,
      SPOT,
      order(SIDE.bid, ORDER_TYPE.limit, MARK - 1_000n, 1n),
    );
    await refuses(attempted(alice, paused), "ExchangePaused");
    expect((await alice.client.cancelAll(SPOT)).cancelled).to.equal(0n);
    await send(rollup, instructions.setPaused(admin.publicKey, false), admin);
  });

  handsOverItsAdminRole(rollup, (by) => [
    instructions.setPaused(by, true),
    instructions.proposeAdmin(by, by),
    instructions.updateMarket(by, SPOT, limits()),
  ]);

  it("replaces all four keys at the owner's word, and closes an empty seat with the rent back", async () => {
    const { alice } = cast;
    const trader = await openedTrader();
    const fresh = OrderKeyManager.fresh(orderKeySeed());
    await send(
      rollup,
      instructions.setOrderKeys(trader.owner.publicKey, fresh.publicKeys),
      trader.owner,
    );
    expect(
      (await trader.client.view()).orderKeys.map((key) => key.toBase58()),
    ).to.deep.equal(fresh.publicKeys.map((key) => key.toBase58()));
    const before = await exchangeBalance();
    await send(
      rollup,
      instructions.closeTrader(trader.owner.publicKey),
      trader.owner,
    );
    expect((await exchangeBalance()) - before).to.equal(TRADER_RENT);
    expect(
      await rollup.getAccountInfo(addresses.view(trader.owner.publicKey)),
    ).to.equal(null);
    expect((await ledgerThroughThePort()).seats[trader.seat].status).to.equal(
      SEAT_CLOSED,
    );
    await refuses(
      send(
        rollup,
        instructions.closeTrader(alice.owner.publicKey),
        alice.owner,
      ),
      "SeatNotEmpty",
    );
  });

  it("opens no more seats in a day than the exchange allows, and lets the admin close a seat nobody ever used", async () => {
    const { alice } = cast;
    const cap = (maxSeatsPerDay: number) =>
      send(
        rollup,
        instructions.updateExchange(admin.publicKey, {
          ...settings(),
          maxSeatsPerDay,
        }),
        admin,
      );
    const today = await exchangeOn(rollup);
    expect(today.seatsDay).to.equal(
      BigInt(await rollupNow()) / SECONDS_PER_DAY,
    );
    expect(today.seatsOpened > 0).to.equal(true);

    await cap(today.seatsOpened + 1);
    const idle = await openedTrader();
    const refused = Keypair.generate();
    await refuses(
      send(
        rollup,
        instructions.openTrader(
          gate.publicKey,
          refused.publicKey,
          newOrderKeys(),
        ),
        gate,
        [refused],
      ),
      "DailySeatLimitReached",
    );
    expect(
      await rollup.getAccountInfo(addresses.view(refused.publicKey)),
    ).to.equal(null);
    await cap(SEATS_PER_DAY);

    const close = (by: Keypair, owner: PublicKey) =>
      send(rollup, instructions.closeUnusedTrader(by.publicKey, owner), by);
    await refuses(close(stranger, idle.owner.publicKey), "NotAdmin");
    await refuses(close(admin, alice.owner.publicKey), "SeatUsed");
    const used = await openedTrader();
    await fundedWith(used, mints.nUSD, 2n);
    await deposited(used, mints.nUSD, { spot: NUSD }, 2n);
    await send(rollup, withdrawal(used, 2n), used.owner);
    await refuses(close(admin, used.owner.publicKey), "SeatUsed");

    const before = await exchangeBalance();
    await close(admin, idle.owner.publicKey);
    expect((await exchangeBalance()) - before).to.equal(TRADER_RENT);
    expect(
      await rollup.getAccountInfo(addresses.view(idle.owner.publicKey)),
    ).to.equal(null);
    expect((await ledgerThroughThePort()).seats[idle.seat].status).to.equal(
      SEAT_CLOSED,
    );
    await custodyMatchesLedger();
  });
});
