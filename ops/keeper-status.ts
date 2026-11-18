/**
 * The keeper's answer to a service that checks on it over the network (the
 * house maker, which will not quote under a keeper it cannot see sweeping).
 * Off unless `KEEPER_STATUS_PORT` is set. A request is
 * `GET <address>?nonce=<32 lowercase hex characters>`; the answer is one JSON
 * object that echoes the nonce and says whether the keeper's last sweep was
 * healthy and when it ended, and carries `x-keeper-signature`, the lowercase
 * hex HMAC-SHA256 of the exact body under the secret in
 * `KEEPER_STATUS_SECRET` (32 characters or more, one per keeper, shared with
 * the service that asks). The nonce is inside what is signed, so an answer
 * kept from an earlier request does not satisfy a new one. Before the first
 * sweep ends there is nothing to say, and the answer is a plain 503.
 */
import { createHmac } from "crypto";
import { createServer, type Server } from "http";
import { at } from "./heartbeat";
import { positiveInteger } from "./upkeep";

export const KEEPER_STATUS_VERSION = 1;
export const KEEPER_SIGNATURE_HEADER = "x-keeper-signature";

const NONCE = /^[0-9a-f]{32}$/;
const KEEPER_ID = /^[A-Za-z0-9_.-]+$/;
const LEAST_SECRET_CHARACTERS = 32;
const MAX_PORT = 65_535;

export type KeeperStatusSettings = {
  port: number;
  host: string;
  id: string;
  secret: string;
};

/**
 * The status endpoint's settings, or null while `KEEPER_STATUS_PORT` is not
 * set. With a port, the keeper's name (`KEEPER_STATUS_ID`, as the asker names
 * it) and the secret must be set too, or the keeper does not start. Nothing
 * here repeats the secret. The address is the loopback one unless
 * `KEEPER_STATUS_HOST` says otherwise, since the asker is usually another
 * container.
 */
export function keeperStatusSettings(
  env: Record<string, string | undefined>,
): KeeperStatusSettings | null {
  if (env.KEEPER_STATUS_PORT === undefined || env.KEEPER_STATUS_PORT === "") {
    return null;
  }
  const id = env.KEEPER_STATUS_ID ?? "";
  if (!KEEPER_ID.test(id)) {
    throw new Error(
      "Set KEEPER_STATUS_ID to the keeper's name, letters, digits, dots, dashes and underscores, as the service that asks names it.",
    );
  }
  const secret = env.KEEPER_STATUS_SECRET ?? "";
  if (secret.length < LEAST_SECRET_CHARACTERS) {
    throw new Error(
      `Set KEEPER_STATUS_SECRET to at least ${LEAST_SECRET_CHARACTERS} characters.`,
    );
  }
  return {
    port: positiveInteger(
      "KEEPER_STATUS_PORT",
      env.KEEPER_STATUS_PORT,
      null,
      MAX_PORT,
    ),
    host: env.KEEPER_STATUS_HOST || "127.0.0.1",
    id,
    secret,
  };
}

/** The last sweep that ended, as the keeper tells it. `seq` counts the healthy ones since the keeper started. */
export type SweepRecord = {
  completedAtMs: number;
  seq: number;
  healthy: boolean;
  failedSteps: number;
};

/** The record after a sweep that ended at `completedAtMs` with `failedSteps` things wrong with it (0 for a healthy one). */
export const afterSweep = (
  before: SweepRecord | null,
  failedSteps: number,
  completedAtMs: number,
): SweepRecord => ({
  completedAtMs,
  seq: (before?.seq ?? 0) + (failedSteps === 0 ? 1 : 0),
  healthy: failedSteps === 0,
  failedSteps,
});

export type StatusReply = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

const plain = (status: number, body: string): StatusReply => ({
  status,
  headers: { "content-type": "text/plain" },
  body,
});

/** The signature a status body carries. */
export const signStatus = (secret: string, body: string) =>
  createHmac("sha256", secret).update(body).digest("hex");

/** The answer to one request: signed status, or a plain refusal. */
export function statusReply(
  method: string | undefined,
  target: string | undefined,
  config: { id: string; network: string; secret: string },
  sweep: SweepRecord | null,
  now: number,
): StatusReply {
  if (method !== "GET") return plain(405, "GET only");
  const nonce = new URL(target ?? "/", "http://keeper").searchParams.get(
    "nonce",
  );
  if (nonce === null || !NONCE.test(nonce)) {
    return plain(400, "nonce must be 32 lowercase hex characters");
  }
  if (sweep === null) return plain(503, "no sweep has completed yet");
  const body = JSON.stringify({
    v: KEEPER_STATUS_VERSION,
    keeper: config.id,
    network: config.network,
    nonce,
    issuedAtMs: Math.max(now, sweep.completedAtMs),
    healthy: sweep.healthy,
    sweepSeq: sweep.seq,
    sweepCompletedAtMs: sweep.completedAtMs,
    failedSteps: sweep.failedSteps,
  });
  return {
    status: 200,
    headers: {
      "content-type": "application/json",
      [KEEPER_SIGNATURE_HEADER]: signStatus(config.secret, body),
    },
    body,
  };
}

/**
 * Starts answering on the settings' address. A server that cannot listen is
 * said once and the keeper goes on: liquidating matters more than being
 * checked, and the asker names a keeper it cannot reach.
 */
export function serveKeeperStatus(
  settings: KeeperStatusSettings,
  network: string,
  sweep: () => SweepRecord | null,
  say: (line: string) => void = console.log,
): Server {
  const server = createServer((request, response) => {
    const reply = statusReply(
      request.method,
      request.url,
      { id: settings.id, network, secret: settings.secret },
      sweep(),
      Date.now(),
    );
    response.writeHead(reply.status, reply.headers);
    response.end(reply.body);
  });
  server.on("error", (error: Error) =>
    say(
      `${at()} keeper status on ${settings.host}:${settings.port} failed: ${error.message.split("\n")[0]}. The keeper goes on.`,
    ),
  );
  server.listen(settings.port, settings.host);
  return server;
}
