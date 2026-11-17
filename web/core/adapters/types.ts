/** The pi-side adapter contract: typed calls, abortable, never throws. */
import type { BridgeError } from "../protocol/errors.ts";

export type AdapterResult<T> = { ok: true; value: T } | { ok: false; error: BridgeError };

export interface AdapterContext {
  cwd: string;
  sessionId?: string;
  grantedCapabilities: readonly string[];
}

/** (ctx, params, signal) => ok/error — the seam every protocol adapter obeys. */
export type ProtocolAdapter<Params = unknown, Result = unknown> = (
  ctx: AdapterContext,
  params: Params,
  signal: AbortSignal,
) => Promise<AdapterResult<Result>>;
