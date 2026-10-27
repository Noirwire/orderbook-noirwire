/**
 * Proves the owner's signed actions work on the rollup this deployment runs
 * on, which may read the Ed25519 proof and the Instructions sysvar differently
 * from a local validator:
 *
 *   [AMOUNT=<tokens, 0.01 by default on a rehearsal; refused on mainnet>]
 *
 * With a fresh owner key made in memory and never written anywhere, the gate
 * opens its trader from the owner's signed message (`open_trader_signed`); the
 * owner's signed message replaces its order keys (`set_order_keys_signed`, nonce
 * 0, then the counter reads 1); the same proof sent again is refused with
 * `WrongOwnerNonce` and a proof for another message with `InvalidOwnerProof`,
 * each leaving the keys as they were. When AMOUNT is set (a rehearsal's default
 * is 0.01 tokens, minted by the admin key) the seat is funded, an order key
 * withdraws it back to the owner's token account (`withdraw_by_key`), and the
 * owner closes the empty seat, so nothing is left behind. It takes 2 tokens at
 * the most.
 *
 * On mainnet nothing is ever funded and AMOUNT is refused: the owner key is not
 * kept, so real tokens sent to it could not be taken back. Mainnet runs the
 * signed open, the key replacement, the two refusals and the close.
 *
 * One line is printed per step, PASS or FAIL with the program's error number
 * where there is one, and the command exits non-zero on any FAIL. The gate key
 * (`<network>-gate.json`) opens the trader and pays for the signed actions;
 * the admin key funds. The Makefile is the way in (`make rehearsal-owner-actions`,
 * `make mainnet-owner-actions`).
 */
import { existsSync } from "fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import nacl from "tweetnacl";
import {
  OrderKeyManager,
  clockOf,
  decodeView,
  ownerActionMessage,
} from "../sdk/dist/index.js";
import {
  adminKeyPath,
  depositingAs,
  errorLine,
  existingKey,
  keyPath,
  rollupIsRunBy,
  run,
  sendingAs,
  type Target,
} from "./deployment";
import { tokenAtoms, roundTripRefusal } from "./exiting";
import { capPreflight, mintRefusal } from "./funding";
import { custodyShown } from "./keeping";
import { heldKey, readingAs } from "./keys";
import { shown } from "./leaving";
import { exchangeInRollup, perpMarketIds } from "./market";
import {
  INVALID_OWNER_PROOF,
  PROOF_LIFETIME_SECONDS,
  WRONG_OWNER_NONCE,
  fundingAmount,
  refusalName,
  refusalVerdict,
  sameKeys,
  stepLine,
  type Verdict,
} from "./owner-acting";
import { deployedAsBuilt } from "./program";
import { gateRefusal } from "./seating";
import { send, until } from "./sending";
import { heldInRollup, tokenBalance } from "./tokens";

const freshSeed = () => Keypair.generate().secretKey.subarray(0, 32);
const base58s = (keys: PublicKey[]) => keys.map((key) => key.toBase58());

run(async (on: Target) => {
  const { instructions } = on;
  const { addresses, programId } = instructions;
  const amount = fundingAmount(process.env, on.mainnet);

  await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  const exchange = await exchangeInRollup(on);
  const gate = existingKey(on, "gate");
  const wrongGate = gateRefusal(
    exchange.gate,
    gate.publicKey,
    keyPath(on, "gate"),
  );
  if (wrongGate) throw new Error(wrongGate);
  const token = exchange.tokens[exchange.collateralToken];
  const funding = amount === null ? null : await fundingPlan(on, token, amount);

  const owner = Keypair.generate();
  const view = addresses.view(owner.publicKey);
  const reader = await readingAs(on.privateUrl, owner);
  const asGate = await sendingAs(on, gate);
  const viewNow = async () => {
    const info = await reader.getAccountInfo(view);
    return info ? decodeView(info.data) : null;
  };
  const expiry = async () =>
    BigInt((await clockOf(on.rollup)) + PROOF_LIFETIME_SECONDS);
  const signed = (message: Uint8Array) =>
    nacl.sign.detached(message, owner.secretKey);

  shown("network", `${on.network}, program ${programId}`);
  shown("owner", `${owner.publicKey.toBase58()} (in memory only)`);
  shown("funding", funding ? `${amount} tokens` : "none");

  let failures = 0;
  const report = (
    status: "PASS" | "FAIL" | "SKIP",
    step: string,
    detail: string,
  ) => {
    if (status === "FAIL") failures += 1;
    console.log(stepLine(status, step, detail));
  };
  const checked = async (
    step: string,
    body: () => Promise<Verdict>,
  ): Promise<boolean> => {
    try {
      const verdict = await body();
      report(verdict.pass ? "PASS" : "FAIL", step, verdict.detail);
      return verdict.pass;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      report("FAIL", step, `${refusalName(text)}: ${errorLine(error)}`);
      return false;
    }
  };
  const refusedWith = async (
    wanted: number,
    steps: Parameters<typeof send>[1],
  ) =>
    refusalVerdict(
      wanted,
      await send(asGate, steps, gate).then(
        () => null,
        (error: Error) => error.message,
      ),
    );

  const first = OrderKeyManager.fresh(freshSeed());
  const second = OrderKeyManager.fresh(freshSeed());
  const atView = async (keys: PublicKey[], nonce: number) => {
    const now = await viewNow();
    return (
      now !== null &&
      now.ownerNonce === nonce &&
      sameKeys(base58s(now.orderKeys), base58s(keys))
    );
  };

  const opened = await checked("open_trader_signed", async () => {
    const expiresAt = await expiry();
    const keys = first.publicKeys;
    await send(
      asGate,
      [
        instructions.openTraderProof(
          owner.publicKey,
          keys,
          expiresAt,
          signed(
            ownerActionMessage(
              "open",
              programId,
              owner.publicKey,
              keys,
              expiresAt,
            ),
          ),
        ),
        instructions.openTraderSigned(
          gate.publicKey,
          owner.publicKey,
          keys,
          expiresAt,
        ),
      ],
      gate,
    );
    await until(viewNow, "the owner's view", 30_000);
    return (await atView(keys, 0))
      ? { pass: true, detail: "view exists, order keys as signed, nonce 0" }
      : { pass: false, detail: "view exists but is not as signed" };
  });

  if (!opened) {
    report("SKIP", "the other steps", "the trader did not open");
  } else {
    const replaceKeys = (keys: PublicKey[], nonce: number, expiresAt: bigint) =>
      instructions.setOrderKeysProof(
        owner.publicKey,
        keys,
        nonce,
        expiresAt,
        signed(
          ownerActionMessage(
            "replace",
            programId,
            owner.publicKey,
            keys,
            expiresAt,
            nonce,
          ),
        ),
      );
    const replacing = await expiry();
    const proof = replaceKeys(second.publicKeys, 0, replacing);
    const update = instructions.setOrderKeysSigned(
      owner.publicKey,
      second.publicKeys,
      0,
      replacing,
    );

    const replaced = await checked("set_order_keys_signed", async () => {
      await send(asGate, [proof, update], gate);
      await until(
        async () => (await atView(second.publicKeys, 1)) || null,
        "the order keys to change",
        30_000,
      );
      return { pass: true, detail: "order keys changed, nonce reads 1" };
    });

    if (replaced) {
      await checked("replayed proof", async () => {
        const verdict = await refusedWith(WRONG_OWNER_NONCE, [proof, update]);
        const unchanged = await atView(second.publicKeys, 1);
        return unchanged
          ? verdict
          : { pass: false, detail: `${verdict.detail}, but the view changed` };
      });

      await checked("proof for a wrong message", async () => {
        const wrong = await expiry();
        const verdict = await refusedWith(INVALID_OWNER_PROOF, [
          replaceKeys(first.publicKeys, 1, wrong),
          instructions.setOrderKeysSigned(
            owner.publicKey,
            OrderKeyManager.fresh(freshSeed()).publicKeys,
            1,
            wrong,
          ),
        ]);
        const unchanged = await atView(second.publicKeys, 1);
        return unchanged
          ? verdict
          : { pass: false, detail: `${verdict.detail}, but the view changed` };
      });

      if (funding) {
        await fundedSteps();
      } else {
        report(
          "SKIP",
          "deposit and withdraw_by_key",
          "the throwaway seat is not funded on mainnet",
        );
      }
    }

    await checked("close_trader", async () => {
      await send(
        await sendingAs(on, owner),
        instructions.closeTrader(owner.publicKey),
        owner,
      );
      await until(
        async () => ((await viewNow()) === null ? true : null),
        "the owner's view to close",
        30_000,
      );
      return {
        pass: true,
        detail: "seat and view closed, nothing left behind",
      };
    });
  }

  if (failures > 0) {
    throw new Error(`${failures} step${failures === 1 ? "" : "s"} failed.`);
  }

  async function fundedSteps(): Promise<void> {
    if (!funding) return;
    const { atoms, mint, payer } = funding;
    const account = getAssociatedTokenAddressSync(mint, owner.publicKey, true);
    const owned = await depositingAs(on, owner);
    const balance = () => tokenBalance(owned, account);

    const funded = await checked("fund the throwaway", async () => {
      await heldInRollup(
        on.solana,
        owned,
        owner,
        mint,
        atoms,
        on.validator,
        token.custodyVisibility,
        payer,
      );
      const held = await balance();
      return {
        pass: held >= atoms,
        detail: `${held} atoms in the owner's balance in the rollup`,
      };
    });
    if (!funded) return;

    const deposited = await checked("deposit", async () => {
      const capped = capPreflight(
        on.profile,
        await custodyShown(
          on,
          token.custodyVisibility,
          addresses.custody(token),
        ),
        token.custodyCap,
        atoms,
      );
      if (capped.refusal) throw new Error(capped.refusal);
      if (capped.note) console.error(capped.note);
      await send(
        owned,
        instructions.deposit(
          owner.publicKey,
          account,
          token,
          owner.publicKey,
          { collateral: true },
          atoms,
        ),
        owner,
      );
      return { pass: true, detail: `${atoms} atoms as collateral` };
    });
    if (!deposited) return;

    await checked("withdraw_by_key", async () => {
      const before = await balance();
      const use = second.take();
      await send(
        await depositingAs(on, use.keypair),
        instructions.withdrawByKey(
          use.keypair.publicKey,
          owner.publicKey,
          use.replacement.publicKey,
          await expiry(),
          account,
          token,
          { collateral: true },
          atoms,
          await perpMarketIds(on),
        ),
        use.keypair,
      );
      await until(
        async () => (await balance()) >= before + atoms || null,
        "the owner's token account to hold the withdrawal",
        30_000,
      );
      const now = await viewNow();
      const rotated =
        now !== null &&
        now.orderKeys[use.slot].equals(use.replacement.publicKey);
      return {
        pass: rotated,
        detail: rotated
          ? `${atoms} atoms back in the owner's token account, order key rotated`
          : "the tokens moved but the order key did not rotate",
      };
    });
  }
});

/**
 * Checks everything funding needs before anything is sent, and gathers it:
 * the atoms, the mint, and who pays on Solana (the admin). Funding is for a
 * rehearsal only, so it is refused without an admin key, or unless that key
 * mints the quote token.
 */
async function fundingPlan(
  on: Target,
  token: Awaited<ReturnType<typeof exchangeInRollup>>["tokens"][number],
  amount: string,
) {
  if (token.mint.equals(PublicKey.default)) {
    throw new Error("The quote token is not registered. Run setup first.");
  }
  const { decimals, mintAuthority } = await getMint(on.solana, token.mint);
  const atoms = tokenAtoms(amount, decimals);
  const tooMuch = roundTripRefusal(atoms, decimals);
  if (tooMuch) throw new Error(tooMuch);
  const adminFile = adminKeyPath(on);
  if (!existsSync(adminFile)) {
    throw new Error(
      `Funding needs the admin key at ${adminFile}, which is missing. Nothing was sent.`,
    );
  }
  const payer = heldKey(adminFile);
  const refusal = mintRefusal(token.mint, mintAuthority, payer.publicKey);
  if (refusal) throw new Error(refusal);
  return { atoms, mint: token.mint, payer };
}
