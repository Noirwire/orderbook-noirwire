"use client";

import { useState, type ReactNode } from "react";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { useConsoleWallet } from "./wallet";
import type { NetworkFacts } from "@/lib/admin-facts";
import { decodeInstructions, type Decoded } from "@/lib/decode";
import { stillTheNetwork, type Expected } from "@/lib/identity";
import { chainOf } from "@/lib/networks";
import { sendSigned, sendingConnection, type Signer } from "@/lib/send";

/** Where an instruction is sent: the rollup endpoint, or the deposit endpoint for what names custody. */
export type Endpoint = "rollup" | "deposit";

/** One transaction, built and decoded, waiting for the operator to read it and sign. */
export type Planned = {
  title: string;
  endpoint: Endpoint;
  instructions: TransactionInstruction[];
  decoded: Decoded[];
  genesis: string;
};

export const urlOf = (network: NetworkFacts, endpoint: Endpoint) =>
  endpoint === "rollup" ? network.rollupUrl : network.depositUrl;

export const expectedOf = (
  network: NetworkFacts,
  endpoint: Endpoint,
): Expected => ({
  solanaUrl: network.solanaUrl,
  genesis: network.genesis,
  url: urlOf(network, endpoint),
  validator: network.validator,
});

export const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const Card = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  <div className="card">
    <h2>{title}</h2>
    {children}
  </div>
);

/** The connected wallet as a signer on `genesis`'s chain, or null when it cannot sign a transaction. */
export function useSigner(genesis: string): Signer | null {
  const { publicKey, signTransaction, signMessage } = useConsoleWallet();
  const chain = chainOf(genesis);
  return publicKey && signTransaction
    ? {
        publicKey,
        signTransaction: (transaction) => signTransaction(transaction, chain),
        signMessage: signMessage ?? undefined,
      }
    : null;
}

/**
 * Builds a transaction for review: refused unless a wallet is connected and
 * the network still answers as checked, then decoded from its own bytes.
 * Resolves to the plan, or throws why there is none.
 */
export async function planned(
  network: NetworkFacts,
  key: PublicKey | null,
  title: string,
  endpoint: Endpoint,
  build: (
    key: PublicKey,
  ) =>
    | TransactionInstruction
    | TransactionInstruction[]
    | Promise<TransactionInstruction | TransactionInstruction[]>,
  programId: PublicKey,
): Promise<Planned> {
  if (!key) throw new Error("Connect the admin's wallet first.");
  await stillTheNetwork(expectedOf(network, endpoint));
  const built = await build(key);
  const instructions = Array.isArray(built) ? built : [built];
  return {
    title,
    endpoint,
    instructions,
    decoded: decodeInstructions(instructions, programId),
    genesis: network.genesis,
  };
}

function InstructionFacts({ decoded }: { decoded: Decoded }) {
  return (
    <>
      <dl className="facts">
        <dt>Program</dt>
        <dd>{decoded.programId}</dd>
        <dt>Instruction</dt>
        <dd>{decoded.name}</dd>
        {decoded.fields.map(([label, value]) => (
          <div key={label} style={{ display: "contents" }}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {decoded.accounts.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Account</th>
                <th>Signer</th>
                <th>Writable</th>
              </tr>
            </thead>
            <tbody>
              {decoded.accounts.map((account, at) => (
                <tr key={`${account.address}-${at}`}>
                  <td className="mono">{at}</td>
                  <td className="mono addr">{account.address}</td>
                  <td className="mono">{account.signer ? "yes" : ""}</td>
                  <td className="mono">{account.writable ? "yes" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hex">data {decoded.dataHex}</p>
    </>
  );
}

/**
 * The transaction as its bytes say, with the network, its genesis, the
 * endpoint and the rollup's validator, before the wallet signs. On mainnet
 * the program id must be typed to go ahead.
 */
export function Review({
  planned,
  network,
  signer,
  onClose,
}: {
  planned: Planned;
  network: NetworkFacts;
  signer: Signer | null;
  onClose: (sent: boolean) => void;
}) {
  const url = urlOf(network, planned.endpoint);
  const [typed, setTyped] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const named = !network.mainnet || typed.trim() === network.programId;
  const busy = progress !== null;
  const several = planned.decoded.length > 1;

  async function send() {
    if (!signer) return;
    setFailure(null);
    const expected = expectedOf(network, planned.endpoint);
    try {
      setProgress("Reading the genesis and the rollup's identity again");
      await stillTheNetwork(expected);
      setProgress(
        url === network.privateUrl
          ? "Signing in to the private endpoint"
          : "Connecting",
      );
      const connection = await sendingConnection(
        url,
        network.privateUrl,
        signer,
      );
      setProgress(
        "Reading the network again, then waiting for the wallet and for confirmation",
      );
      setSignature(
        await sendSigned(connection, planned.instructions, signer, expected),
      );
    } catch (error) {
      setFailure(reasonOf(error));
    } finally {
      setProgress(null);
    }
  }

  return (
    <section className="review" aria-label="Review before signing">
      <h2>{planned.title}: review before signing</h2>
      <dl className="facts">
        <dt>Network</dt>
        <dd>{network.label}</dd>
        <dt>Genesis</dt>
        <dd>
          {planned.genesis}, read from {network.solanaUrl} when this review
          opened and matching networks.json; read again right before the wallet
          signs
        </dd>
        <dt>Sent to</dt>
        <dd>
          {url} (
          {planned.endpoint === "rollup"
            ? "rollup endpoint"
            : "deposit endpoint"}
          )
        </dd>
        <dt>Rollup run by</dt>
        <dd>
          {network.validator}, the identity {url} answered with when this review
          opened, as networks.json names it; asked again right before the wallet
          signs
        </dd>
        <dt>Fee payer</dt>
        <dd>
          {signer?.publicKey.toBase58() ?? "no wallet"}; the wallet must hand
          back this transaction unchanged, or nothing is sent
        </dd>
        {several && (
          <>
            <dt>Instructions</dt>
            <dd>{planned.decoded.length}, in one transaction, in this order</dd>
          </>
        )}
      </dl>
      {planned.decoded.map((decoded, at) => (
        <div key={`${decoded.dataHex}-${at}`} className="review-part">
          {several && (
            <span className="label">
              Instruction {at + 1} of {planned.decoded.length}
            </span>
          )}
          <InstructionFacts decoded={decoded} />
        </div>
      ))}
      {network.mainnet && !signature && (
        <label className="field">
          <span className="label">
            This is mainnet: type the program id to go ahead
          </span>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
      )}
      {failure && <p className="error">{failure}</p>}
      {signature && <p className="success">Landed: {signature}</p>}
      {progress && <p className="dim">{progress}</p>}
      <div className="row">
        {!signature && (
          <button
            type="button"
            className="primary"
            disabled={!signer || !named || busy}
            onClick={send}
          >
            Sign and send
          </button>
        )}
        <button
          type="button"
          className="quiet"
          disabled={busy}
          onClick={() => onClose(signature !== null)}
        >
          {signature ? "Done" : "Cancel"}
        </button>
      </div>
    </section>
  );
}
