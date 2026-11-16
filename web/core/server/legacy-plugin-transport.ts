/**
 * The sole external-plugin raw-response compatibility boundary.
 *
 * Old plugins receive the real Node request/response and may write before
 * returning { handled: true }. Never auto-send after such a write, even when
 * the handler subsequently throws or times out. New first-party handlers must
 * return a body or stream instead; no fake ServerResponse is involved here.
 */
import type { FastifyReply } from "fastify";
import type { PluginRouteResponse } from "../plugin-contracts/kernel/routes.ts";

/** Returns true when raw ownership prevents any further Fastify response. */
export function settleLegacyPluginReply(reply: FastifyReply, response?: PluginRouteResponse): boolean {
  const raw = reply.raw;
  if (response?.handled !== true && !raw.headersSent && !raw.writableEnded && !raw.destroyed) return false;
  reply.hijack();
  // An already-started response cannot be replaced by a 502. Terminate it on
  // handler failure rather than leave an orphaned, half-written byte stream.
  if (response === undefined && !raw.writableEnded) raw.destroy();
  return true;
}
