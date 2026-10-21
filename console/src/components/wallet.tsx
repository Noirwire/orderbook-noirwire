"use client";

import "./buffer-global";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
} from "@wallet-standard/features";
import {
  SolanaSignMessage,
  SolanaSignTransaction,
  type SolanaSignMessageFeature,
  type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";

const REMEMBERED = "console-wallet";

type ConnectFeature = StandardConnectFeature[typeof StandardConnect];
type DisconnectFeature = StandardDisconnectFeature[typeof StandardDisconnect];
type EventsFeature = StandardEventsFeature[typeof StandardEvents];
type SignTransactionFeature =
  SolanaSignTransactionFeature[typeof SolanaSignTransaction];
type SignMessageFeature = SolanaSignMessageFeature[typeof SolanaSignMessage];

const featureOf = <T,>(wallet: Wallet, name: string) =>
  (wallet.features as Record<string, unknown>)[name] as T | undefined;

/** A wallet the console can use: it connects, signs a Solana transaction and names a Solana chain. */
const usable = (wallet: Wallet) =>
  StandardConnect in wallet.features &&
  SolanaSignTransaction in wallet.features &&
  wallet.chains.some((chain) => chain.startsWith("solana:"));

function remembered(): string | null {
  try {
    return window.localStorage.getItem(REMEMBERED);
  } catch {
    return null;
  }
}

function remember(name: string | null): boolean {
  try {
    if (name) window.localStorage.setItem(REMEMBERED, name);
    else window.localStorage.removeItem(REMEMBERED);
    return true;
  } catch {
    return false;
  }
}

export type ConsoleWallet = {
  /** The wallet-standard wallets in this browser the console can use. */
  wallets: readonly Wallet[];
  publicKey: PublicKey | null;
  connecting: boolean;
  connect: (wallet: Wallet) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Signs the serialized transaction for `chain`; whatever the wallet returns is handed back as it is. */
  signTransaction:
    ((transaction: Transaction, chain: string) => Promise<Transaction>) | null;
  /** The signature over exactly `message`, refused when the wallet signed anything else. */
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | null;
};

const WalletContext = createContext<ConsoleWallet>({
  wallets: [],
  publicKey: null,
  connecting: false,
  connect: async () => {},
  disconnect: async () => {},
  signTransaction: null,
  signMessage: null,
});

export const useConsoleWallet = () => useContext(WalletContext);

type Connected = { wallet: Wallet; account: WalletAccount };

/**
 * The wallets of the wallet-standard, read straight from the browser: no
 * adapter, no wallet list of its own. The connected wallet is remembered in
 * this browser only, to reconnect silently on the next visit.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<readonly Wallet[]>([]);
  const [connected, setConnected] = useState<Connected | null>(null);
  const [connecting, setConnecting] = useState(false);

  const connectTo = useCallback(async (wallet: Wallet, silent: boolean) => {
    const feature = featureOf<ConnectFeature>(wallet, StandardConnect);
    if (!feature) return;
    setConnecting(true);
    try {
      const { accounts } = await feature.connect({ silent });
      const account = accounts[0] ?? wallet.accounts[0];
      if (!account) return;
      setConnected({ wallet, account });
      remember(wallet.name);
    } finally {
      setConnecting(false);
    }
  }, []);

  useEffect(() => {
    const registry = getWallets();
    let reconnecting = false;
    const refresh = () => {
      const found = registry.get().filter(usable);
      setWallets(found);
      const name = remembered();
      const wallet = name && found.find((each) => each.name === name);
      if (!wallet || reconnecting) return;
      reconnecting = true;
      connectTo(wallet, true).catch(() => remember(null));
    };
    const ready = setTimeout(refresh, 0);
    const offRegister = registry.on("register", refresh);
    const offUnregister = registry.on("unregister", refresh);
    return () => {
      clearTimeout(ready);
      offRegister();
      offUnregister();
    };
  }, [connectTo]);

  useEffect(() => {
    if (!connected) return;
    const events = featureOf<EventsFeature>(connected.wallet, StandardEvents);
    if (!events) return;
    return events.on("change", ({ accounts }) => {
      if (!accounts) return;
      const kept = accounts.find(
        (account) => account.address === connected.account.address,
      );
      if (kept) return;
      setConnected(
        accounts[0] ? { wallet: connected.wallet, account: accounts[0] } : null,
      );
    });
  }, [connected]);

  const value = useMemo<ConsoleWallet>(() => {
    const signTransactionFeature =
      connected &&
      featureOf<SignTransactionFeature>(
        connected.wallet,
        SolanaSignTransaction,
      );
    const signMessageFeature =
      connected &&
      featureOf<SignMessageFeature>(connected.wallet, SolanaSignMessage);
    return {
      wallets,
      publicKey: connected ? new PublicKey(connected.account.publicKey) : null,
      connecting,
      connect: (wallet) => connectTo(wallet, false),
      disconnect: async () => {
        const wallet = connected?.wallet;
        setConnected(null);
        remember(null);
        if (wallet) {
          await featureOf<DisconnectFeature>(
            wallet,
            StandardDisconnect,
          )?.disconnect();
        }
      },
      signTransaction:
        connected && signTransactionFeature
          ? async (transaction, chain) => {
              const [output] = await signTransactionFeature.signTransaction({
                account: connected.account,
                transaction: transaction.serialize({
                  requireAllSignatures: false,
                  verifySignatures: false,
                }),
                chain: chain as `${string}:${string}`,
              });
              if (!output) throw new Error("The wallet signed nothing.");
              return Transaction.from(output.signedTransaction);
            }
          : null,
      signMessage:
        connected && signMessageFeature
          ? async (message) => {
              const [output] = await signMessageFeature.signMessage({
                account: connected.account,
                message,
              });
              if (
                !output ||
                !Buffer.from(output.signedMessage).equals(Buffer.from(message))
              ) {
                throw new Error(
                  "The wallet signed a message other than the one it was given.",
                );
              }
              return output.signature;
            }
          : null,
    };
  }, [wallets, connected, connecting, connectTo]);

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}
