/**
 * Tops up the exchange's float on the rollup, the lamports that pay the rent
 * of every view the gate opens and of the ledger's growth:
 *
 *   KEYFILE=<a funded wallet's key file> AMOUNT=<SOL, such as 1.1>
 *
 * The exchange is delegated, so SOL sent to its address on Solana never
 * reaches the rollup. This sends MagicBlock's delegated lamports transfer
 * instead: the wallet pays on Solana into a transfer account delegated to the
 * same rollup, and the rollup credits the exchange from it. Any funded wallet
 * can send it, not only the admin's, and nothing here can take lamports out of
 * the exchange. It prints the exchange's lamports on the rollup before and
 * after, and fails unless they rose by the amount.
 *
 * The Makefile is the way in (`make rehearsal-float-topup`,
 * `make mainnet-float-topup`).
 */
import { randomBytes } from "crypto";
import {
  DelegationStatus,
  deriveLamportsPda,
  getDelegationRecord,
  lamportsDelegatedTransferIx,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { rollupIsRunBy, run } from "./deployment";
import { floatDelegationRefusal, floatTopUpRequest } from "./launch";
import { ownerAt, shown } from "./leaving";
import { exchangeInRollup } from "./market";
import { deployedAsBuilt } from "./program";
import { sendOnSolana, until } from "./sending";

/** Kept back beyond the amount for the transaction's fees and the rent of the transfer's own accounts on Solana, so the send cannot fall short. */
const FEE_ALLOWANCE_LAMPORTS = 10_000_000n;

run(async (on) => {
  const request = floatTopUpRequest(process.env);
  const wallet = ownerAt(request.keyFile);
  await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  await exchangeInRollup(on);
  const exchange = on.instructions.addresses.exchange;
  const record = await getDelegationRecord(on.solana, exchange);
  const refusal = floatDelegationRefusal(
    record.status === DelegationStatus.Undelegated ? null : record.validator,
    on.validator,
  );
  if (refusal) throw new Error(refusal);
  const held = BigInt(await on.solana.getBalance(wallet.publicKey));
  if (held < request.lamports + FEE_ALLOWANCE_LAMPORTS) {
    throw new Error(
      `${wallet.publicKey.toBase58()} holds ${held} lamports on Solana, short of ${request.lamports} plus ${FEE_ALLOWANCE_LAMPORTS} for fees and rent. Nothing was sent.`,
    );
  }
  const inRollup = async () =>
    BigInt((await on.rollup.getAccountInfo(exchange))?.lamports ?? 0);
  const before = await inRollup();
  const salt = randomBytes(32);
  const [transfer] = deriveLamportsPda(wallet.publicKey, exchange, salt);
  shown("network", `${on.network}, program ${on.instructions.programId}`);
  shown("exchange", exchange.toBase58());
  shown("from", wallet.publicKey.toBase58());
  shown("in transit at", transfer.toBase58());
  shown("float before", `${before} lamports`);
  const signature = await sendOnSolana(
    on.solana,
    lamportsDelegatedTransferIx(
      wallet.publicKey,
      exchange,
      request.lamports,
      salt,
    ),
    wallet,
  );
  shown("signature", signature);
  const after = await until(async () => {
    const now = await inRollup();
    return now >= before + request.lamports ? now : null;
  }, "the rollup to credit the exchange").catch(() => {
    throw new Error(
      `The transfer landed on Solana (${signature}), but within a minute the rollup did not show the exchange's float up by ${request.lamports} lamports from ${before}. The SOL waits at ${transfer.toBase58()} until the rollup credits it, and a view opened meanwhile spends from the float. Read the float on the rollup before sending more: running this again sends a second amount.`,
    );
  });
  shown("float after", `${after} lamports (${after - before} more)`);
});
