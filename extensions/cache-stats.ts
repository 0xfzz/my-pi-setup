// Sidebar "Cache" section: did the last request hit the provider's prompt cache?
//
// Reads the usage every assistant message already carries, so it costs no
// requests and no tokens. The section stays hidden until a provider reports
// prompt tokens.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addSample, cacheRows, emptyTotals, sampleOf, type CacheSample } from "../lib/cache-stats.ts";
import { offerSection, REFRESH_EVENT } from "../lib/sidebar/sidebar-channel.ts";

export default function cacheStatsExtension(pi: ExtensionAPI): void {
  let totals = emptyTotals();
  let last: CacheSample | undefined;

  const publish = (): void => {
    const view = cacheRows(last, totals);
    offerSection(pi, {
      id: "cache",
      title: last ? `Cache ${Math.round((last.hitRate ?? 0) * 100)}%` : "Cache",
      tone: view.tone,
      rows: view.rows,
      hint: "prompt cache · read / new",
    });
  };

  pi.on("session_start", () => { totals = emptyTotals(); last = undefined; publish(); });
  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; stopReason?: string; usage?: Parameters<typeof sampleOf>[0] };
    if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") return;
    const sample = sampleOf(message.usage);
    if (!sample) return;
    last = sample;
    totals = addSample(totals, sample);
    publish();
  });
  // The sidebar clears its sections on tree navigation and asks everyone to re-offer.
  pi.events?.on(REFRESH_EVENT, () => { if (last) publish(); });
}
