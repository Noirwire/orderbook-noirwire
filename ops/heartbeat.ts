/**
 * The heartbeat the crank and the keeper send to a dead-man's switch
 * (`HEALTHCHECK_URL`): a plain GET after each good round or sweep, so a
 * service outside the server knows they are alive and says so when they are
 * not. A ping that fails is logged and dropped; it never stops a round, is
 * never retried in a loop and never waits for the next one.
 */

import { chmodSync, renameSync, writeFileSync } from "fs";
import { withoutUrls } from "./deployment";

/** How long a ping may take before it is given up on. */
export const HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * What every line names the ping address as. No part of the address is
 * logged, the host included: a dead-man's switch can carry its credential in a
 * subdomain, and the log store keeps what is printed.
 */
export const HEARTBEAT_LABEL = "HEALTHCHECK_URL";

/**
 * The address to ping, or null when `HEALTHCHECK_URL` is not set. A ping
 * address is a secret of its own (whoever has it can say the service is
 * alive), so no message here repeats it.
 */
export function heartbeatUrl(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  let protocol: string | null = null;
  try {
    protocol = new URL(value).protocol;
  } catch {
    // Not an address at all: refused below, without showing it.
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(
      "HEALTHCHECK_URL is not an http or https address. Give the ping address the dead-man's switch shows, or leave it out. Nothing was sent.",
    );
  }
  return value;
}

export const at = () => new Date().toISOString();

/**
 * A function that pings `url` and resolves once the ping has ended, whatever
 * came of it. A ping still out when the next one is due is not repeated: the
 * next one waits for it. With no `url` it does nothing.
 */
export function heartbeatTo(
  url: string | null,
  say: (line: string) => void = console.log,
  fetcher: typeof fetch = fetch,
): () => Promise<void> {
  let out: Promise<void> | null = null;
  const ping = async (address: string) => {
    try {
      const response = await fetcher(address, {
        method: "GET",
        signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {});
      if (!response.ok) {
        say(
          `${at()} heartbeat to ${HEARTBEAT_LABEL} was refused with status ${response.status}: check HEALTHCHECK_URL. The service goes on.`,
        );
      }
    } catch (error) {
      const reason = withoutUrls(
        error instanceof Error ? error.message : String(error),
        { HEALTHCHECK_URL: address },
      );
      say(
        `${at()} heartbeat to ${HEARTBEAT_LABEL} failed: ${reason.split("\n")[0]}. The service goes on; if this lasts, the dead-man's switch will raise the alarm, so check the server's network.`,
      );
    }
  };
  return () => {
    if (url === null) return Promise.resolve();
    out ??= ping(url).finally(() => {
      out = null;
    });
    return out;
  };
}

/** What every line names the heartbeat file as. */
export const HEARTBEAT_FILE_LABEL = "KEEPER_HEARTBEAT_FILE";

/**
 * A function that stamps the time in Unix milliseconds into `path`, for a
 * service on the same host that gates its readiness on it; with no `path` it
 * does nothing. The stamp is written beside the file and renamed in, so a
 * reader never sees half of it, and readable by every user because it carries
 * no secret. It is not synced to disk: a stamp lost in a crash is a stamp
 * that went stale. A write that fails is logged and dropped, once until a
 * write works again, and never stops a sweep.
 */
export function heartbeatFile(
  path: string | undefined,
  say: (line: string) => void = console.log,
  now: () => number = Date.now,
): () => void {
  let failing = false;
  return () => {
    if (path === undefined || path === "") return;
    const partial = `${path}.tmp`;
    try {
      writeFileSync(partial, String(now()), { mode: 0o644 });
      chmodSync(partial, 0o644);
      renameSync(partial, path);
    } catch (error) {
      if (!failing) {
        say(
          `${at()} heartbeat to ${HEARTBEAT_FILE_LABEL} failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}. The keeper goes on; check the file's directory.`,
        );
      }
      failing = true;
      return;
    }
    if (failing) {
      say(`${at()} heartbeat to ${HEARTBEAT_FILE_LABEL} works again`);
      failing = false;
    }
  };
}
