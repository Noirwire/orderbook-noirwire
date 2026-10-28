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
 * each leaving the keys as they were. The correct text with one signature byte
 * flipped must be refused by the Ed25519 check itself, before the program runs
 * (instruction 0): the only step that fails on a rollup that does not verify
 * signatures, which would let anyone replace anyone's order keys, so a FAIL
 * there blocks the upgrade. Then a key replacement is sent with a
 * fresh throwaway fee payer that has no account, and another with the owner's
 * signature over the Solana off-chain message envelope, which is what a
 * hardware wallet signs; a proof that expires too far ahead is refused with
 * `OwnerExpiryTooFar`. When AMOUNT is set (a rehearsal's default is 0.01
 * tokens, minted by the admin key) the seat is funded, an order key asking for
 * a token account of the owner's that is not its associated one is refused with
 * `WrongWithdrawDestination`, an order key withdraws it back to the owner's
 * token account (`withdraw_by_key`), and the owner closes the empty seat, so
 * nothing is left behind. It takes 2 tokens at the most.
 *
 * On mainnet nothing is ever funded and AMOUNT is refused: the owner key is not
 * kept, so real tokens sent to it could not be taken back. Mainnet runs the
 * signed open, the key replacements, the refusals and the close.
 *
 * One line is printed per step, PASS or FAIL with the program's error number
 * where there is one, and the command exits non-zero on any FAIL. The gate key
 * (`<network>-gate.json`) opens the trader and pays for the signed actions;
 * the admin key funds. The Makefile is the way in (`make rehearsal-owner-actions`,
 * `make mainnet-owner-actions`).
 */
import { existsSync } from "fs";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  createInitializeAccount3Instruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import {
  MAX_EXPIRY_AHEAD,
  OrderKeyManager,
  clockOf,
  decodeView,
  ownerActionMessage,
  ownerExpiry,
  ownerSignedBytes,
  type OwnerMessageForm,
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
import { mintRefusal } from "./funding";
import { heldKey, readingAs } from "./keys";
import { shown } from "./leaving";
import { exchangeInRollup, perpMarketIds } from "./market";
import {
  INVALID_OWNER_PROOF,
  OWNER_EXPIRY_TOO_FAR,
  PROOF_LIFETIME_SECONDS,
  TOO_FAR_SECONDS,
  WRONG_OWNER_NONCE,
  WRONG_WITHDRAW_DESTINATION,
  fundingAmount,
  refusalName,
  refusalVerdict,
  sameKeys,
  stepLine,
  tamperedSignatureVerdict,
  withFlippedSignatureByte,
  type Verdict,
} from "./owner-acting";
import { deployedAsBuilt } from "./program";
import { gateRefusal } from "./seating";
import { send, until } from "./sending";
import { heldInRollup, tokenBalance } from "./tokens";

/** An order key's withdrawal is held to the instruction limit (60 s), not the owner proof's 120 s. */
const ORDER_KEY_LIFETIME_SECONDS = MAX_EXPIRY_AHEAD - 10;

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
    ownerExpiry(await clockOf(on.rollup), PROOF_LIFETIME_SECONDS);
  const orderKeyExpiry = async () =>
    BigInt((await clockOf(on.rollup)) + ORDER_KEY_LIFETIME_SECONDS);
  const signed = (message: Uint8Array, form: OwnerMessageForm = "raw") =>
    nacl.sign.detached(
      ownerSignedBytes(message, form, { programId, owner: owner.publicKey }),
      owner.secretKey,
    );

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
  let live = second;
  let nonce = 1;
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
    const replaceKeys = (
      keys: PublicKey[],
      at: number,
      expiresAt: bigint,
      form: OwnerMessageForm = "raw",
    ) =>
      instructions.setOrderKeysProof(
        owner.publicKey,
        keys,
        at,
        expiresAt,
        signed(
          ownerActionMessage(
            "replace",
            programId,
            owner.publicKey,
            keys,
            expiresAt,
            at,
          ),
          form,
        ),
        form,
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

      await checked("proof with one flipped signature byte", async () => {
        const spare = OrderKeyManager.fresh(freshSeed()).publicKeys;
        const flipping = await expiry();
        const verdict = tamperedSignatureVerdict(
          await send(
            asGate,
            [
              withFlippedSignatureByte(replaceKeys(spare, 1, flipping)),
              instructions.setOrderKeysSigned(
                owner.publicKey,
                spare,
                1,
                flipping,
              ),
            ],
            gate,
          ).then(
            () => null,
            (error: Error) => error.message,
          ),
        );
        const unchanged = await atView(second.publicKeys, 1);
        return unchanged
          ? verdict
          : { pass: false, detail: `${verdict.detail}, but the view changed` };
      });

      const keysChangedTo = async (keys: OrderKeyManager) => {
        await until(
          async () => (await atView(keys.publicKeys, nonce + 1)) || null,
          "the order keys to change",
          30_000,
        );
        live = keys;
        nonce += 1;
      };

      await checked(
        "set_order_keys_signed, fresh fee payer with no account",
        async () => {
          const payer = Keypair.generate();
          const next = OrderKeyManager.fresh(freshSeed());
          const expiresAt = await expiry();
          await send(
            await sendingAs(on, payer),
            [
              replaceKeys(next.publicKeys, nonce, expiresAt),
              instructions.setOrderKeysSigned(
                owner.publicKey,
                next.publicKeys,
                nonce,
                expiresAt,
              ),
            ],
            payer,
          );
          await keysChangedTo(next);
          return {
            pass: true,
            detail: `order keys changed by a payer with no account, nonce reads ${nonce}`,
          };
        },
      );

      await checked("set_order_keys_signed, off-chain envelope", async () => {
        const next = OrderKeyManager.fresh(freshSeed());
        const expiresAt = await expiry();
        await send(
          asGate,
          [
            replaceKeys(next.publicKeys, nonce, expiresAt, "envelope"),
            instructions.setOrderKeysSigned(
              owner.publicKey,
              next.publicKeys,
              nonce,
              expiresAt,
            ),
          ],
          gate,
        );
        await keysChangedTo(next);
        return {
          pass: true,
          detail: `order keys changed by an enveloped signature, nonce reads ${nonce}`,
        };
      });

      await checked(
        "set_order_keys_signed, off-chain specification header",
        async () => {
          const next = OrderKeyManager.fresh(freshSeed());
          const expiresAt = await expiry();
          await send(
            asGate,
            [
              replaceKeys(next.publicKeys, nonce, expiresAt, "spec"),
              instructions.setOrderKeysSigned(
                owner.publicKey,
                next.publicKeys,
                nonce,
                expiresAt,
              ),
            ],
            gate,
          );
          await keysChangedTo(next);
          return {
            pass: true,
            detail: `order keys changed by a signature over the specification header, nonce reads ${nonce}`,
          };
        },
      );

      await checked("expiry too far ahead", async () => {
        const spare = OrderKeyManager.fresh(freshSeed()).publicKeys;
        const far = BigInt((await clockOf(on.rollup)) + TOO_FAR_SECONDS);
        const verdict = await refusedWith(OWNER_EXPIRY_TOO_FAR, [
          replaceKeys(spare, nonce, far),
          instructions.setOrderKeysSigned(owner.publicKey, spare, nonce, far),
        ]);
        const unchanged = await atView(live.publicKeys, nonce);
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

    await checked("wrong withdrawal destination", async () => {
      const elsewhere = Keypair.generate();
      await send(
        on.solana,
        [
          SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: elsewhere.publicKey,
            lamports:
              await on.solana.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),
            space: ACCOUNT_SIZE,
            programId: TOKEN_PROGRAM_ID,
          }),
          createInitializeAccount3Instruction(
            elsewhere.publicKey,
            mint,
            owner.publicKey,
          ),
        ],
        payer,
        [elsewhere],
      );
      const use = live.take();
      const refusal = await send(
        await depositingAs(on, use.keypair),
        instructions.withdrawByKey(
          use.keypair.publicKey,
          owner.publicKey,
          use.replacement.publicKey,
          await orderKeyExpiry(),
          elsewhere.publicKey,
          token,
          { collateral: true },
          atoms,
          await perpMarketIds(on),
        ),
        use.keypair,
      ).then(
        () => null,
        (error: Error) => error.message,
      );
      const verdict = refusalVerdict(WRONG_WITHDRAW_DESTINATION, refusal);
      const view = await viewNow();
      const kept =
        view !== null && view.orderKeys[use.slot].equals(use.keypair.publicKey);
      live.release(use, view ?? undefined);
      return kept
        ? verdict
        : {
            pass: false,
            detail: `${verdict.detail}, but the order key rotated`,
          };
    });

    await checked("withdraw_by_key", async () => {
      const before = await balance();
      const use = live.take();
      await send(
        await depositingAs(on, use.keypair),
        instructions.withdrawByKey(
          use.keypair.publicKey,
          owner.publicKey,
          use.replacement.publicKey,
          await orderKeyExpiry(),
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
