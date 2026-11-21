/**
 * The one read the keeper makes of a trigger book, which is sealed and so not
 * one of the public accounts it holds in memory from the websocket: the book's
 * sweep cursor, from its first bytes alone.
 */
import {
  HEADER_LEN,
  TRIGGER_BOOK_HEADER_LEN,
  decodeTriggerBookHeader,
} from "../sdk/dist/index.js";
import type { Target } from "./deployment";

/**
 * The book's sweep cursor, or null where the book cannot be read: only a
 * reader the rollup's permission names sees it, and the cursor is on chain
 * either way, so the next sweep call resumes there regardless. Reads only the
 * header, not the book's 7 MB.
 */
export async function sweepCursorOf(
  on: Pick<Target, "rollup" | "instructions">,
  marketId: number,
): Promise<number | null> {
  try {
    const account = await on.rollup.getAccountInfo(
      on.instructions.addresses.triggers(marketId),
      {
        dataSlice: { offset: 0, length: HEADER_LEN + TRIGGER_BOOK_HEADER_LEN },
      },
    );
    return account ? decodeTriggerBookHeader(account.data).sweepCursor : null;
  } catch {
    return null;
  }
}
