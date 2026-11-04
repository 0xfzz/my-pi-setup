// Opt-in diagnostic: PI_CACHE_TRACE=1 appends one JSON line per provider request
// to <agent dir>/cache-trace.jsonl saying where it stopped sharing a prefix with
// the previous request of the same provider. Content is never written, only
// hashes and counts. Off by default.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { diverge, fingerprint, type Fingerprint } from "../lib/payload-fingerprint.ts";

export default function cacheTraceExtension(pi: ExtensionAPI): void {
  if (!process.env.PI_CACHE_TRACE) return;
  const file = join(getAgentDir(), "cache-trace.jsonl");
  const last = new Map<string, Fingerprint>();

  pi.on("before_provider_request", (event, ctx) => {
    const current = fingerprint(event.payload);
    if (!current) return undefined;
    const key = `${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"}`;
    const previous = last.get(key);
    last.set(key, current);
    const line = {
      at: new Date().toISOString(), model: key, items: current.items.length,
      ...(previous ? { vsPrevious: diverge(previous, current) } : { first: true }),
    };
    try { appendFileSync(file, `${JSON.stringify(line)}\n`); } catch { /* diagnostics must never break a request */ }
    return undefined;
  });
}
