// Typed fetch layer for the MCP manager page. Every request carries the
// selected session id; the server resolves the working directory and pi's own
// config surface does the read and the write.

import type { PiApiName, PiApiParams, PiApiResult, PiMcpConfigState, PiMcpWriteParams } from "../../../core/shared/pi-api.ts";
import { protocolClient } from "../../../core/client/protocol-client.ts";
import type { ApiFailure, ApiResult } from "../../../core/client/plugin-system/api-client.ts";

export type McpFailure = ApiFailure;
export type McpResult<T> = ApiResult<T>;

/**
 * Run one pi_api call. The facade answers `{ok, result|error}` inside a 200, so
 * its own verdict — not the HTTP status — decides success.
 */
async function callPiApi<K extends PiApiName>(
  sessionId: string,
  api: K,
  params: PiApiParams[K],
): Promise<McpResult<PiApiResult[K]>> {
  const outcome = await protocolClient(sessionId).piApi(api, params);
  if (outcome.ok) return { ok: true, data: outcome.value };
  // The protocol keeps the host's named error code; no transport vocabulary leaks.
  return { ok: false, code: outcome.error.code, message: outcome.error.message, status: 200 };
}

/** Unwrap a pi_api outcome into the state it must carry, or a failure. */
function asMcpState(outcome: McpResult<unknown>, failure: string): McpResult<PiMcpConfigState> {
  if (outcome.ok && isMcpState(outcome.data)) return { ok: true, data: outcome.data };
  return { ok: false, code: "pi_api", message: failure, status: 200 };
}

/** Read the merged MCP state pi would connect with. */
export async function fetchMcpState(sessionId: string): Promise<McpResult<PiMcpConfigState>> {
  return asMcpState(await callPiApi(sessionId, "mcp.read", {}), "MCP configuration could not be read");
}

/** Apply one mutation; pi returns the fresh state after the write. */
export async function writeMcpConfig(
  sessionId: string,
  params: PiMcpWriteParams,
): Promise<McpResult<PiMcpConfigState>> {
  return asMcpState(await callPiApi(sessionId, "mcp.write", params), "the change was not applied");
}

function isMcpState(value: unknown): value is PiMcpConfigState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as { servers?: unknown; globalConfigPath?: unknown };
  return Array.isArray(state.servers) && typeof state.globalConfigPath === "string";
}
