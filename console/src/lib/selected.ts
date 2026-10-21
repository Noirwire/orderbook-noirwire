import { cookies } from "next/headers";
import {
  checkedNetwork,
  chainState,
  type ChainState,
  type Checked,
} from "./chain";
import { NETWORK_COOKIE } from "./networks";

export type Loaded =
  | { checked: Checked & { ok: false }; state: null; error: null }
  | { checked: Checked & { ok: true }; state: ChainState; error: null }
  | { checked: Checked & { ok: true }; state: null; error: string };

/** The network the operator picked, its genesis checked, and its public state once the check passed. */
export async function selected(): Promise<Loaded> {
  const name = (await cookies()).get(NETWORK_COOKIE)?.value;
  const checked = await checkedNetwork(name);
  if (!checked.ok) return { checked, state: null, error: null };
  try {
    return { checked, state: await chainState(checked.network), error: null };
  } catch (error) {
    return {
      checked,
      state: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
