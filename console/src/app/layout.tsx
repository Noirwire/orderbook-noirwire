import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/access";
import { Nav, NetworkPicker, WalletButton } from "@/components/chrome";
import { NETWORKS, VIEWERS } from "@/lib/networks";
import { selected } from "@/lib/selected";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Order book console",
  description: "The operator's console for the order book program.",
  robots: { index: false, follow: false },
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { checked, state, error } = await selected();
  const { network } = checked;
  const exchange = state?.exchange ?? null;
  return (
    <html lang="en">
      <body>
        <Providers
          facts={{
            admin: exchange?.admin.toBase58() ?? null,
            pendingAdmin: exchange?.pendingAdmin?.toBase58() ?? null,
            viewers: VIEWERS,
            strangers: network.strangers,
          }}
        >
          <header className="top">
            <div className="brand">
              <span className="mark" aria-hidden="true" />
              Order book console
            </div>
            <Nav />
            <div className="top-right">
              <NetworkPicker
                networks={NETWORKS.map(({ name, label }) => ({ name, label }))}
                current={network.name}
              />
              <WalletButton />
            </div>
          </header>
          <div className="network-line mono">
            <span>{network.label}</span>
            <span>program {network.programId || "not named"}</span>
            <span>
              genesis {checked.genesis ?? "unread"}
              {checked.ok ? " verified" : ""}
            </span>
            <span>
              rollup {network.validator || "not named"}
              {checked.ok ? " verified" : ""}
            </span>
          </div>
          <main className="page">
            {!checked.ok ? (
              <section className="notice danger">
                <h2>Nothing is shown for this network</h2>
                <p>{checked.why}</p>
              </section>
            ) : error ? (
              <section className="notice danger">
                <h2>The chain could not be read</h2>
                <p className="mono">{error}</p>
              </section>
            ) : (
              children
            )}
          </main>
        </Providers>
      </body>
    </html>
  );
}
