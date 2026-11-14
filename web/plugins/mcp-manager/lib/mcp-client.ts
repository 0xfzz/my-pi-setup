// Typed fetch layer for the MCP manager page. Every request carries the
// selected session id; the server resolves the working directory and pi's own
// config surface does the read and the write.

import type { PiMcpConfigState, PiMcpWriteParams } from "../../../core/shared/pi-api.ts";
import { postJson, type ApiFailure, type ApiResult } from "../../../core/client/plugin-system/api-client.ts";

export type McpFailure = ApiFailure;
export type McpResult<T> = ApiResult<T>;

/** The envelope `POST /api/agent/:id/pi_api` answers with. */
interface PiApiEnvelope {
  ok?: unknown;
  result?: unknown;
  error?: unknown;
}

/**
 * Run one pi_api call. The facade answers `{ok, result|error}` inside a 200, so
 * its own verdict — not the HTTP status — decides success.
 */
async function callPiApi(sessionId: string, api: string, params: unknown): Promise<McpResult<unknown>> {
  const url = `/api/agent/${encodeURIComponent(sessionId)}/pi_api`;
  const outcome = await postJson<PiApiEnvelope>(url, { api, params });
  if (!outcome.ok) return outcome;
  if (outcome.data.ok !== true) {
    return {
      ok: false,
      code: "pi_api",
      message: typeof outcome.data.error === "string" ? outcome.data.error : `pi api ${api} failed`,
      status: 200,
    };
  }
  return { ok: true, data: outcome.data.result };
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
