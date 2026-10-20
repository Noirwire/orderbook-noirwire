/**
 * Audit, custody area. A stranger who knows a custody address before the
 * admin uses it can take that custody balance away from this exchange for
 * good.
 *
 * The custody balance of a token is the Ephemeral SPL Token balance of its
 * custody authority, an address of this program derived from a nonce the
 * admin chooses at registration. The token program lets any payer create
 * that balance for any owner, delegate it to any validator named in the
 * instruction data, or attach a permission to it. Once delegated, a second
 * delegation to another validator is refused, and only the balance's owner
 * can undelegate it, which this program never signs for. So a balance a
 * stranger claimed first is lost to the exchange.
 *
 * The nonce is random and private until the admin delegates the balance, so
 * nobody can claim it in advance. This plays a nonce that leaked anyway: the
 * set-up refuses the claimed balance loudly instead of reporting success,
 * and the admin skips it by choosing another nonce.
 *
 * Plug in right after `./orderbook/set-up` in `orderbook.test.ts`. It uses a
 * fresh mint, registers nothing, and leaves the story untouched.
 */
import { expect } from "chai";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  createEataPermissionIx,
  delegateEphemeralAtaIx,
  initEphemeralAtaIx,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { randomCustodyNonce, type CustodyToken } from "../../sdk/dist/index.js";
import { createMint, ensureCustody } from "../../ops/tokens";
import {
  VALIDATOR,
  addresses,
  admin,
  rollup,
  send,
  solana,
  until,
} from "../support";
import { refuses } from "../orderbook/world";

describe("audit: custody claimed by a stranger before registration", () => {
  const attacker = Keypair.generate();
  const nobodysValidator = Keypair.generate().publicKey;
  let mint: PublicKey;
  let leaked: CustodyToken;
  let leakedPermission: CustodyToken;

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
    leaked = { mint, custodyNonce: randomCustodyNonce() };
    leakedPermission = { mint, custodyNonce: randomCustodyNonce() };
  });

  it("lets a stranger who knows the nonce delegate the custody balance to a validator nobody runs", async () => {
    const balance = addresses.custodyBalance(leaked);
    await send(
      solana,
      [
        initEphemeralAtaIx(
          balance,
          addresses.custodyAuthority(leaked.custodyNonce),
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

  it("refuses that custody loudly instead of reporting it set up", async () => {
    for (const visibility of ["sealed", "public"] as const) {
      await refuses(
        ensureCustody(solana, admin, addresses, leaked, VALIDATOR, visibility),
        `is delegated to ${nobodysValidator.toBase58()}`,
        `a ${visibility} custody claimed by a stranger`,
      );
    }
  });

  it("refuses a public custody a stranger attached a permission to", async () => {
    const balance = addresses.custodyBalance(leakedPermission);
    await send(
      solana,
      [
        initEphemeralAtaIx(
          balance,
          addresses.custodyAuthority(leakedPermission.custodyNonce),
          mint,
          attacker.publicKey,
        ),
        createEataPermissionIx(balance, attacker.publicKey),
      ],
      attacker,
    );
    await refuses(
      ensureCustody(
        solana,
        admin,
        addresses,
        leakedPermission,
        VALIDATOR,
        "public",
      ),
      "has a permission",
    );
  });

  it("sets the mint's custody up under another nonce, which reaches this rollup", async () => {
    const fresh = { mint, custodyNonce: randomCustodyNonce() };
    const custody = await ensureCustody(
      solana,
      admin,
      addresses,
      fresh,
      VALIDATOR,
      "public",
    );
    expect(custody.equals(addresses.custody(leaked))).to.equal(false);
    await until(
      () => rollup.getAccountInfo(custody),
      "the custody under the fresh nonce",
    );
    const again = await ensureCustody(
      solana,
      admin,
      addresses,
      fresh,
      VALIDATOR,
      "public",
    );
    expect(
      again.equals(custody),
      "set up again, it is found as this exchange's",
    ).to.equal(true);
  });
});
