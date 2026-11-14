// Files plugin — server half. Mounts the session-scoped file browser API under
// the plugin's own namespace, /api/p/files/*, so the Files panel extends the
// backend the same way any third-party plugin does. The audited path/symlink
// policy and the streaming implementation live in web/core/server/files.ts;
// this module only adapts them to the plugin route contract, so one
// implementation guards every traversal case.

import { listDirectory, readText, searchPaths, statusForCode, streamFile, type FileFailure } from "../../../core/server/files.ts";
import { getPluginHost } from "../../../core/server/plugin-host.ts";
import type { PluginContext, PluginRuntime } from "../../../core/plugin-contracts/kernel/manager.ts";
import type { PluginRouteRequest, PluginRouteResponse } from "../../../core/plugin-contracts/kernel/routes.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

/** A resolved request target: the plugin's own scope for this call. */
interface FileTarget {
  sessionId: string;
  root: string;
}

function failureResponse(failure: FileFailure): PluginRouteResponse {
  return { status: statusForCode(failure.code), body: { error: failure.message, code: failure.code } };
}

/** The host resolves the session root before dispatch; absent means unknown session. */
function targetOf(request: PluginRouteRequest): FileTarget | PluginRouteResponse {
  if (request.sessionId === undefined || request.sessionRoot === undefined) {
    return { status: 404, body: { error: "Session not found", code: "unknown_session" } };
  }
  return { sessionId: request.sessionId, root: request.sessionRoot };
}

function isResponse(value: FileTarget | PluginRouteResponse): value is PluginRouteResponse {
  return "status" in value || "body" in value;
}

/**
 * The `file.before-read` veto: any plugin may refuse a read with a user-visible
 * reason. A veto is audited and answered 403 instead of serving content.
 */
async function vetoedByHook(target: FileTarget, path: string): Promise<PluginRouteResponse | null> {
  const host = getPluginHost();
  if (host === null) return null;
  const veto = await host.hooks.bail("file.before-read", { sessionId: target.sessionId, root: target.root, path });
  if (!veto.denied) return null;
  host.manager.recordVeto(veto.pluginId, "file.before-read", veto.reason);
  return { status: 403, body: { error: veto.reason, code: "permission", vetoedBy: veto.pluginId } };
}

async function handleList(request: PluginRouteRequest): Promise<PluginRouteResponse> {
  const target = targetOf(request);
  if (isResponse(target)) return target;
  const result = await listDirectory(
    target.root,
    request.query.get("path") ?? "",
    request.query.get("hidden") === "1",
  );
  return result.ok ? { status: 200, body: result } : failureResponse(result);
}

async function handleRead(request: PluginRouteRequest): Promise<PluginRouteResponse> {
  const target = targetOf(request);
  if (isResponse(target)) return target;
  const path = request.query.get("path") ?? "";
  const veto = await vetoedByHook(target, path);
  if (veto !== null) return veto;
  const result = await readText(target.root, path);
  return result.ok ? { status: 200, body: result } : failureResponse(result);
}

async function handleSearch(request: PluginRouteRequest): Promise<PluginRouteResponse> {
  const target = targetOf(request);
  if (isResponse(target)) return target;
  const result = await searchPaths(target.root, request.query.get("q") ?? "");
  return result.ok ? { status: 200, body: result } : failureResponse(result);
}

/**
 * Byte streaming owns the response, so it uses the raw transport escape hatch:
 * `streamFile` writes headers and body itself and this handler reports it.
 */
async function handleDownload(request: PluginRouteRequest): Promise<PluginRouteResponse> {
  const target = targetOf(request);
  if (isResponse(target)) return target;
  const path = request.query.get("path") ?? "";
  const veto = await vetoedByHook(target, path);
  if (veto !== null) return veto;
  const transport = request.transport;
  if (transport === undefined) {
    return { status: 500, body: { error: "download requires the raw transport" } };
  }
  await streamFile(
    transport.request as IncomingMessage,
    transport.response as ServerResponse,
    target.root,
    path,
    request.query.get("download") === "1",
  );
  return { handled: true };
}

const filesRuntime: PluginRuntime = {
  setup: (ctx: PluginContext) => {
    // The mount is the plugin id: /api/p/files, /api/p/files/read, …
    ctx.routes.get("", handleList);
    ctx.routes.get("read", handleRead);
    ctx.routes.get("search", handleSearch);
    ctx.routes.get("download", handleDownload);
  },
};

export default filesRuntime;
