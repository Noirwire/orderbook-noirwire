/**
 * Audit, custody area. A stranger can take a mint's custody balance away
 * from this exchange for good before the admin sets it up.
 *
 * The custody balance of a mint is the Ephemeral SPL Token balance of the
 * custody authority, a fixed address of this program, so anyone can derive it
 * from the program id and the mint. The token program lets any payer create
 * that balance for any owner and delegate it to any validator named in the
 * instruction data (the existing set-up story already does both with the
 * admin as payer for a balance the admin does not own). Once delegated, a
 * second delegation to another validator is refused, and only the balance's
 * owner can undelegate it. The owner is the custody authority, which this
 * program never signs for towards the token program. So the custody balance
 * stays delegated to the stranger's validator, never reaches this rollup, and
 * the mint can never be registered or deposited here.
 *
 * Plug in right after `./orderbook/set-up` in `orderbook.test.ts`. It uses a
 * fresh mint and the never-registered index, and leaves the story untouched.
 */
import { expect } from "chai";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import {
  DELEGATION_PROGRAM_ID,
  delegateEphemeralAtaIx,
  deriveEphemeralAta,
  initEphemeralAtaIx,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { createMint, ensureCustody } from "../../ops/tokens";
import {
  VALIDATOR,
  addresses,
  admin,
  instructions,
  refusal,
  rollup,
  send,
  solana,
} from "../support";
import { UNREGISTERED, exchangeOn } from "../orderbook/world";

const WAIT_FOR_THE_ROLLUP_MS = 20_000;

describe("audit: custody delegated to a foreign validator", () => {
  const attacker = Keypair.generate();
  const nobodysValidator = Keypair.generate().publicKey;
  let mint: PublicKey;
  let balance: PublicKey;

  before(async () => {
    await send(
      solana,
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: attacker.publicKey,
        lamports: LAMPORTS_PER_SOL / 10,
      }),
      admin,
    );
    mint = await createMint(solana, admin, 6);
    balance = deriveEphemeralAta(addresses.custodyAuthority, mint)[0];
  });

  it("lets a stranger create the custody balance and delegate it to a validator nobody runs", async () => {
    await send(
      solana,
      [
        initEphemeralAtaIx(
          balance,
          addresses.custodyAuthority,
          mint,
          attacker.publicKey,
        ),
        delegateEphemeralAtaIx(attacker.publicKey, balance, nobodysValidator),
      ],
      attacker,
    );
    const onSolana = await solana.getAccountInfo(balance);
    expect(
      onSolana?.owner.equals(DELEGATION_PROGRAM_ID),
      "the custody balance is delegated, by a stranger",
    ).to.equal(true);
  });

  it("refuses the admin's delegation to the exchange's validator afterwards", async () => {
    const refused = await refusal(
      send(
        solana,
        [
          createAssociatedTokenAccountIdempotentInstruction(
            admin.publicKey,
            addresses.custody(mint),
            addresses.custodyAuthority,
            mint,
          ),
          delegateEphemeralAtaIx(admin.publicKey, balance, VALIDATOR),
        ],
        admin,
      ),
    );
    expect(refused.length > 0, refused).to.equal(true);
  });

  it("reports the custody as set up when it is not: ensureCustody returns on any delegation", async () => {
    const custody = await ensureCustody(
      solana,
      admin,
      addresses,
      mint,
      VALIDATOR,
      "public",
    );
    expect(custody.equals(addresses.custody(mint))).to.equal(true);
  });

  it("never lets the admin register or use the mint in this rollup", async () => {
    const deadline = Date.now() + WAIT_FOR_THE_ROLLUP_MS;
    let last = "";
    while (Date.now() < deadline) {
      last = await refusal(
        send(
          rollup,
          instructions.registerToken(
            admin.publicKey,
            UNREGISTERED,
            mint,
            "public",
          ),
          admin,
        ),
      );
    }
    expect(last.length > 0, last).to.equal(true);
    const { tokens } = await exchangeOn(rollup);
    expect(tokens[UNREGISTERED].mint.equals(PublicKey.default)).to.equal(true);
  });
});
