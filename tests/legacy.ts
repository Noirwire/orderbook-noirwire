/**
 * What `make test-upgrade` needs to drive the earlier build of the program,
 * whose seat is taken when a view is opened and whose ledger sits at the
 * address the new ledger's relayout reads from: the instructions whose
 * accounts or bytes changed, in the earlier form, and the ledger's address,
 * until `upgraded()` says the new build is deployed over it. After that every
 * instruction is the current one.
 */
import { createHash } from "crypto";
import { TransactionInstruction, type PublicKey } from "@solana/web3.js";
import {
  Addresses,
  Instructions,
  LEGACY_LEDGER_LEN,
  LEGACY_LEDGER_PREFIX,
  LEGACY_SEATS,
  LEGACY_SEAT_LEN,
  decodeLegacySeat,
  type Ledger,
  type SeatAccess,
} from "../sdk/dist/index.js";

/** The run starts on the earlier build when `make test-upgrade` names the new one to deploy. */
export const runsOnEarlierBuild = Boolean(process.env.UPGRADE_SO);

let onEarlierBuild = runsOnEarlierBuild;

/** Whether the program at the address is still the earlier build. */
export const isEarlierBuild = () => onEarlierBuild;

/** The new build is deployed: from here on every instruction and address is the current one. */
export function upgraded(): void {
  onEarlierBuild = false;
}

const currentLedger = Object.getOwnPropertyDescriptor(
  Addresses.prototype,
  "ledger",
);
if (!currentLedger?.get) throw new Error("Addresses has no ledger address");
Object.defineProperty(Addresses.prototype, "ledger", {
  configurable: true,
  get(this: Addresses): PublicKey {
    return onEarlierBuild
      ? this.legacyLedger
      : (currentLedger.get as () => PublicKey).call(this);
  },
});

const DISCRIMINATOR_LEN = 8;
const PUBKEY_LEN = 32;

export class TestInstructions extends Instructions {
  override openTrader(
    gate: PublicKey,
    owner: PublicKey,
    orderKeys: PublicKey[],
  ): TransactionInstruction {
    return this.withTheLedger(super.openTrader(gate, owner, orderKeys));
  }

  override openTraderSigned(
    gate: PublicKey,
    owner: PublicKey,
    orderKeys: PublicKey[],
    expiresAt: bigint,
  ): TransactionInstruction {
    return this.withTheLedger(
      super.openTraderSigned(gate, owner, orderKeys, expiresAt),
    );
  }

  override setSeatAccess(
    admin: PublicKey,
    owner: PublicKey,
    access: SeatAccess,
    perpMarketIds: number[],
  ): TransactionInstruction {
    const built = super.setSeatAccess(admin, owner, access, perpMarketIds);
    if (!onEarlierBuild) return built;
    built.keys.splice(3, 1);
    const lists = Buffer.from([
      Number(access.makerMarkets),
      Number(access.takerMarkets),
      access.blocked ? 1 : 0,
    ]);
    built.data = Buffer.concat([
      built.data.subarray(0, DISCRIMINATOR_LEN + PUBKEY_LEN),
      lists,
    ]);
    return built;
  }

  /**
   * The earlier build refuses every deposit into a custody whose cap is zero,
   * and `set_custody_cap` raises it. The new build has no such instruction.
   */
  setCustodyCap(admin: PublicKey, index: number, cap: bigint) {
    const discriminator = createHash("sha256")
      .update("global:set_custody_cap")
      .digest()
      .subarray(0, DISCRIMINATOR_LEN);
    const amount = Buffer.alloc(8);
    amount.writeBigUInt64LE(cap);
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: admin, isSigner: true, isWritable: false },
        { pubkey: this.addresses.exchange, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([discriminator, Buffer.from([index]), amount]),
    });
  }

  /** The earlier `open_trader` names the ledger, after the exchange. */
  private withTheLedger(built: TransactionInstruction): TransactionInstruction {
    if (!onEarlierBuild) return built;
    built.keys.splice(3, 0, {
      pubkey: this.addresses.ledger,
      isSigner: false,
      isWritable: true,
    });
    return built;
  }
}

/** The earlier build's ledger, which holds seats of `LEGACY_SEAT_LEN` bytes. */
export function decodeEarlierLedger(data: Uint8Array): Ledger {
  if (data.length !== LEGACY_LEDGER_LEN) {
    throw new Error(`${data.length} bytes are not the earlier ledger`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const seats = Array.from({ length: LEGACY_SEATS }, (_, at) =>
    decodeLegacySeat(data, LEGACY_LEDGER_PREFIX + at * LEGACY_SEAT_LEN),
  );
  return {
    header: {
      tag: new TextDecoder().decode(data.subarray(0, 8)),
      ready: data[8] !== 0,
      marketId: data[9],
      bump: data[10],
    },
    openSeats: view.getUint32(16, true),
    freeHead: 0,
    seats,
  };
}
