/**
 * The pi_api protocol seam. Behavior stays in pi's own built-in API host;
 * this module only validates the wire form, delegates, and maps failures to
 * the protocol's single error shape.
 */
import { bridgeError } from "../protocol/errors.ts";
import { parsePiApiBody } from "../server/pi-api-body.ts";
import { callPiApi } from "../server/pi-api.ts";
import type { PiApiName, PiApiParams, PiApiResult } from "../shared/pi-api.ts";
import type { AdapterContext, AdapterResult, ProtocolAdapter } from "./types.ts";

type PiApiAdapterResult = AdapterResult<PiApiResult[PiApiName]>;

interface Invocation {
  readonly ctx: AdapterContext;
  readonly api: PiApiName;
  readonly params: unknown;
  readonly signal: AbortSignal;
}

function failure(
  code: "VALIDATION_FAILED" | "ADAPTER_UNAVAILABLE",
  api: PiApiName,
  reason: string,
): PiApiAdapterResult {
  return {
    ok: false,
    error: bridgeError(code, `pi_api ${api}: ${reason}`, { api }),
  };
}

async function invoke({ ctx, api, params, signal }: Invocation): Promise<PiApiAdapterResult> {
  if (signal.aborted) return failure("ADAPTER_UNAVAILABLE", api, "aborted");

  const parsed = parsePiApiBody({ api, params });
  if ("error" in parsed) return failure("VALIDATION_FAILED", api, parsed.error);

  // parsePiApiBody is the wire validator; the cast narrows its `unknown`
  // params to the pair the registry dispatches for this api name.
  const outcome = await callPiApi(ctx.cwd, api, parsed.params as PiApiParams[PiApiName]);
  if (!outcome.ok) return failure("ADAPTER_UNAVAILABLE", api, "dispatch failed");
  return { ok: true, value: outcome.result };
}

function createAdapter(api: PiApiName): ProtocolAdapter {
  return (ctx, params, signal) => invoke({ ctx, api, params, signal });
}

export const piApiAdapters = {
  "autocomplete.suggestions": createAdapter("autocomplete.suggestions"),
  "commands.builtin": createAdapter("commands.builtin"),
  "settings.read": createAdapter("settings.read"),
  "settings.write": createAdapter("settings.write"),
  "settings.models.read": createAdapter("settings.models.read"),
  "settings.models.write": createAdapter("settings.models.write"),
  "trust.read": createAdapter("trust.read"),
  "trust.write": createAdapter("trust.write"),
  "auth.read": createAdapter("auth.read"),
  "auth.login": createAdapter("auth.login"),
  "auth.state": createAdapter("auth.state"),
  "auth.answer": createAdapter("auth.answer"),
  "auth.logout": createAdapter("auth.logout"),
  "mcp.read": createAdapter("mcp.read"),
  "mcp.write": createAdapter("mcp.write"),
} satisfies Record<PiApiName, ProtocolAdapter>;
