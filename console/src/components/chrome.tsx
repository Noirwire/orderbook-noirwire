"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useAccess } from "./access";
import { useConsoleWallet } from "./wallet";

const PAGES = [
  { href: "/", label: "Exchange" },
  { href: "/markets", label: "Markets" },
  { href: "/prices", label: "Prices" },
  { href: "/custody", label: "Custody" },
  { href: "/launch", label: "Launch" },
  { href: "/admin", label: "Actions", admin: true },
  { href: "/access-lists", label: "Access lists", admin: true },
];

export function Nav() {
  const pathname = usePathname();
  const { role } = useAccess();
  const isAdmin = role === "admin" || role === "nominee";
  return (
    <nav className="nav" aria-label="Pages">
      {PAGES.filter((page) => !page.admin || isAdmin).map((page) => (
        <Link
          key={page.href}
          href={page.href}
          className={pathname === page.href ? "nav-link current" : "nav-link"}
        >
          {page.label}
        </Link>
      ))}
    </nav>
  );
}

export function NetworkPicker({
  networks,
  current,
}: {
  networks: { name: string; label: string }[];
  current: string;
}) {
  const router = useRouter();
  return (
    <label className="picker">
      <span className="label">Network</span>
      <select
        value={current}
        onChange={(event) => {
          document.cookie = `network=${event.target.value}; path=/; max-age=31536000; samesite=strict`;
          router.refresh();
        }}
      >
        {networks.map((network) => (
          <option key={network.name} value={network.name}>
            {network.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const ROLE_LABEL = {
  admin: "admin",
  nominee: "pending admin",
  viewer: "viewer",
  stranger: "read only",
};

export function WalletButton() {
  const { wallets, connect, disconnect, publicKey, connecting } =
    useConsoleWallet();
  const { role } = useAccess();
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (publicKey) {
    const key = publicKey.toBase58();
    return (
      <div className="wallet">
        <span className="role">{ROLE_LABEL[role]}</span>
        <span className="mono">{`${key.slice(0, 4)}…${key.slice(-4)}`}</span>
        <button type="button" className="quiet" onClick={() => disconnect()}>
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <div className="wallet">
      <span className="role">{ROLE_LABEL.stranger}</span>
      <button
        type="button"
        className="quiet"
        onClick={() => setOpen(!open)}
        disabled={connecting}
      >
        {connecting ? "Connecting" : "Connect wallet"}
      </button>
      {open && (
        <div className="wallet-menu" role="menu">
          {wallets.length === 0 && (
            <p className="dim">
              No wallet found in this browser. Install a Solana wallet that
              supports wallet-standard.
            </p>
          )}
          {wallets.map((each) => (
            <button
              key={each.name}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setFailure(null);
                connect(each).catch((error: Error) =>
                  setFailure(error.message),
                );
              }}
            >
              {each.name}
            </button>
          ))}
        </div>
      )}
      {failure && <span className="error">{failure}</span>}
    </div>
  );
}
