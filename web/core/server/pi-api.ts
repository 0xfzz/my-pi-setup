/**
 * The server-side pi_api host.
 *
 * The web server dispatches pi built-in api calls into the SAME registry the
 * extension uses (web/core/pi-api) — the implementations are pi's own
 * modules (pi-tui's autocomplete, pi's builtin command list). Requests are
 * aborted with the server, and per-session cwd changes rebuild providers
 * (the modules own that).
 *
 * This module owns only lifecycle + validation; pi owns the behavior.
 */
import { createPiApiRegistry, PI_API_MODULES } from "../pi-api/index.ts";
import type { PiApiName, PiApiParams, PiApiResult } from "../shared/pi-api.ts";
import { getWebLogger } from "../http/logging.ts";
import { parsePiApiBody } from "./pi-api-body.ts";

export type PiApiCall =
  | { ok: true; result: PiApiResult[PiApiName] }
  | { ok: false; error: string };

const registry = createPiApiRegistry({
  onError: (api, error) => getWebLogger().error({ err: error, api }, "pi api dispatch failed"),
});
for (const module of PI_API_MODULES) registry.register(module);

/** A server-lifetime abort controller: dispatches stop when the server does. */
const serverLifetime = new AbortController();

/**
 * Run one pi built-in api for a session. Typed call site for internal
 * consumers (routes use the parsed wire form).
 */
export function callPiApi(
  cwd: string,
  api: PiApiName,
  params: PiApiParams[PiApiName],
): Promise<PiApiCall> {
  return registry.dispatch(api, params, { cwd, signal: serverLifetime.signal }).then((outcome) =>
    outcome.ok ? { ok: true, result: outcome.result as PiApiResult[PiApiName] } : { ok: false, error: outcome.error },
  );
}

/** Route-level entry: validate the wire body, then dispatch. */
export function handlePiApiRequest(
  cwd: string,
  body: unknown,
): Promise<{ status: number; body: PiApiCall }> {
  const parsed = parsePiApiBody(body);
  if ("error" in parsed) return Promise.resolve({ status: 400, body: { ok: false, error: parsed.error } });
  const params = parsed.params as PiApiParams[PiApiName];
  return callPiApi(cwd, parsed.api, params).then((result) => ({
    status: result.ok ? 200 : 500,
    body: result,
  }));
}
