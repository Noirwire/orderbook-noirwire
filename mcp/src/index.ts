#!/usr/bin/env node
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig } from "./config.js";
import { acquireLock, ownerLockPath } from "./lock.js";
import { buildSession, SessionHost } from "./session.js";
import { loadOrCreateKeypair } from "./storage.js";
import { registerTools } from "./tools.js";

/**
 * Stdout belongs to the protocol, so anything this process says goes to
 * stderr. The session is built by the first tool that needs it.
 */
async function main(): Promise<void> {
  const config = resolveConfig(process.env, homedir());
  const { keypair, created } = loadOrCreateKeypair(config.keypairPath);
  if (created) {
    process.stderr.write(
      `created a new devnet trader ${keypair.publicKey.toBase58()}, keypair saved at ${config.keypairPath}\n`,
    );
  }
  const releaseLock = acquireLock(ownerLockPath(homedir(), keypair.publicKey));
  const host = new SessionHost(() => buildSession(config, keypair));

  const server = new McpServer({
    name: "noirwire-orderbook",
    version: "0.1.0",
  });
  registerTools(server, config.simUrl, host);

  process.on("exit", () => {
    host.close();
    releaseLock();
  });
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
  server.server.onclose = () => process.exit(0);

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `noirwire-orderbook-mcp ready (devnet test network), simulation service ${config.simUrl}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `noirwire-orderbook-mcp failed to start: ${String(error)}\n`,
  );
  process.exit(1);
});
