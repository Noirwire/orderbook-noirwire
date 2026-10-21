"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { WalletProvider, useConsoleWallet } from "./wallet";

/**
 * Who the connected wallet is to this console. `admin` is the exchange's
 * admin as the chain records it; `nominee` the pending admin; `viewer` a key
 * on the viewer list of `networks.json`. The role is worked out in the
 * browser from a wallet that proves nothing to the server, and the server
 * renders every page into the HTML it sends, so this hides pages from view
 * only; it is never a security boundary. Everything shown is public anyway,
 * and the program's own signer check is what refuses a stranger's admin
 * instruction.
 */
export type Role = "admin" | "nominee" | "viewer" | "stranger";

export type AccessFacts = {
  admin: string | null;
  pendingAdmin: string | null;
  viewers: string[];
  strangers: "stats" | "none";
};

type Access = { role: Role; key: string | null; seesStats: boolean };

const AccessContext = createContext<Access>({
  role: "stranger",
  key: null,
  seesStats: false,
});

function roleOf(key: string | null, facts: AccessFacts): Role {
  if (!key) return "stranger";
  if (key === facts.admin) return "admin";
  if (key === facts.pendingAdmin) return "nominee";
  return facts.viewers.includes(key) ? "viewer" : "stranger";
}

function AccessProvider({
  facts,
  children,
}: {
  facts: AccessFacts;
  children: ReactNode;
}) {
  const { publicKey } = useConsoleWallet();
  const key = publicKey?.toBase58() ?? null;
  const value = useMemo(() => {
    const role = roleOf(key, facts);
    return {
      role,
      key,
      seesStats: role !== "stranger" || facts.strangers === "stats",
    };
  }, [key, facts]);
  return (
    <AccessContext.Provider value={value}>{children}</AccessContext.Provider>
  );
}

export const useAccess = () => useContext(AccessContext);

export function Providers({
  facts,
  children,
}: {
  facts: AccessFacts;
  children: ReactNode;
}) {
  return (
    <WalletProvider>
      <AccessProvider facts={facts}>{children}</AccessProvider>
    </WalletProvider>
  );
}

/** Shows its content to the roles that may see it, and says what is needed otherwise. */
export function Gate({
  need,
  children,
}: {
  need: "stats" | "admin";
  children: ReactNode;
}) {
  const { role, seesStats } = useAccess();
  const allowed =
    need === "admin" ? role === "admin" || role === "nominee" : seesStats;
  if (allowed) return <>{children}</>;
  return (
    <section className="notice">
      <h2>{need === "admin" ? "Admin only" : "Viewers only"}</h2>
      <p>
        {need === "admin"
          ? "Connect the wallet the exchange records as its admin. The actions are rendered for it alone, and the program refuses any other signer anyway."
          : "Connect a wallet on the viewer list in networks.json to see this network's public stats."}
      </p>
    </section>
  );
}
