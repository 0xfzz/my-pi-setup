// Typed fetch layer for the MCP manager page. Every request carries the
// selected session id; the server resolves the working directory and pi's own
// config surface does the read and the write. Returns a discriminated result
// so the page can tell a real failure from an empty list.

import type { PiMcpConfigState, PiMcpWriteParams } from "../../../core/shared/pi-api.ts";

export type McpFailure = { ok: false; message: string };
export type McpResult<T> = { ok: true; data: T } | McpFailure;

/** Run one pi_api call and shape the body into a typed result. */
async function callPiApi(
  sessionId: string,
  api: string,
  params: unknown,
): Promise<McpResult<unknown>> {
  let response: Response;
  try {
    response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/pi_api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api, params }),
    });
  } catch {
    return { ok: false, message: "the web server did not answer" };
  }
  const body = await response.json().catch(() => ({}));
  if (body.ok !== true) {
    return { ok: false, message: typeof body.error === "string" ? body.error : `pi api ${api} failed` };
  }
  return { ok: true, data: body.result };
}

/** Unwrap a pi_api outcome into the state it must carry, or a failure. */
function asMcpState(outcome: McpResult<unknown>, failure: string): McpResult<PiMcpConfigState> {
  if (outcome.ok && isMcpState(outcome.data)) return { ok: true, data: outcome.data };
  return { ok: false, message: failure };
}

/** Read the merged MCP state pi would connect with. */
export async function fetchMcpState(sessionId: string): Promise<McpResult<PiMcpConfigState>> {
  const outcome = await callPiApi(sessionId, "mcp.read", {});
  return asMcpState(outcome, "MCP configuration could not be read");
}

/** Apply one mutation; pi returns the fresh state after the write. */
export async function writeMcpConfig(
  sessionId: string,
  params: PiMcpWriteParams,
): Promise<McpResult<PiMcpConfigState>> {
  const outcome = await callPiApi(sessionId, "mcp.write", params);
  return asMcpState(outcome, "the change was not applied");
}

function isMcpState(value: unknown): value is PiMcpConfigState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as { servers?: unknown; globalConfigPath?: unknown };
  return Array.isArray(state.servers) && typeof state.globalConfigPath === "string";
}
