// Keep the prompt-cache breakpoints on the parts of a request that survive.
//
// Pi marks the system prompt, the last tool and the last block of the final
// message. Several extensions here append request-local text at that tail (the
// artifact catalog, checkpoint snapshots, the todo line, the mode reminder), so
// the only conversation-level marker landed on text the next request no longer
// sends and every call re-wrote the whole conversation. The plan lives in
// lib/cache-anchor.ts and the reasoning in docs/token-efficiency.md.
//
// It is its own extension rather than part of the sidebar's Cache section: a
// correctness fix must not disappear when someone hides a UI section.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { planCacheBreakpoints } from "../lib/cache-anchor.ts";

export default function cacheBreakpointsExtension(pi: ExtensionAPI): void {
  // Mutates the serialised payload in place. A payload with no marker, or none
  // this plan can improve, comes back exactly as it arrived.
  pi.on("before_provider_request", (event) => {
    planCacheBreakpoints(event.payload);
    return event.payload;
  });
}
