import test from "node:test";
import assert from "node:assert/strict";
import { addSample, cacheRows, cacheWebView, emptyTotals, isCostlyMiss, sampleOf, tokens } from "../lib/cache-stats.ts";
import cacheStats from "../extensions/cache-stats.ts";
import { SECTION_EVENT, type SectionOffer } from "../lib/sidebar/sidebar-channel.ts";
import { WEB_PLUGIN_VIEW_EVENT } from "../lib/web-plugins/view.ts";

test("a sample is the cached share of the whole prompt", () => {
  const sample = sampleOf({ input: 200, cacheRead: 17_800, cacheWrite: 0 })!;
  assert.equal(sample.prompt, 18_000);
  assert.ok(Math.abs(sample.hitRate! - 17_800 / 18_000) < 1e-9);
  assert.equal(sampleOf({ input: 0, cacheRead: 0, cacheWrite: 0 }), undefined);
  assert.equal(sampleOf(undefined), undefined);
  assert.equal(sampleOf({ input: -5, cacheRead: Number.NaN })?.prompt, undefined, "garbage counts as zero");
});

test("token counts are compact", () => {
  assert.deepEqual([842, 1234, 18_400, 1_400_000].map(tokens), ["842", "1.2k", "18k", "1.4M"]);
});

test("a warm request reads as a success and a cold large one is flagged", () => {
  const warm = sampleOf({ input: 300, cacheRead: 19_700 })!;
  const warmView = cacheRows(warm, addSample(emptyTotals(), warm));
  assert.equal(warmView.tone, "success");
  assert.match(warmView.rows[0]!, /^last 99% hit · 20k read$/);

  const cold = sampleOf({ input: 15_000, cacheWrite: 3000, cacheRead: 0 })!;
  assert.equal(isCostlyMiss(cold), true);
  const coldView = cacheRows(cold, addSample(addSample(emptyTotals(), warm), cold));
  assert.equal(coldView.tone, "warning");
  assert.match(coldView.rows[2]!, /miss: 15k new · 3\.0k written/);
  assert.match(coldView.rows[1]!, /session \d+% · 2 req/);
});

test("small prompts are never flagged and a provider without caching says so", () => {
  const tiny = sampleOf({ input: 900 })!;
  assert.equal(isCostlyMiss(tiny), false);
  assert.equal(cacheRows(tiny, addSample(emptyTotals(), tiny)).rows[2], "provider reports no cache");
  assert.deepEqual(cacheRows(undefined, emptyTotals()).rows, []);
});

test("the web view leads with the last request and keeps the sidebar's wording", () => {
  const cold = sampleOf({ input: 15_000, cacheWrite: 3000, cacheRead: 0 })!;
  const totals = addSample(emptyTotals(), cold);
  const view = cacheWebView(cold, totals);
  assert.equal(view.title, "Cache 0%");
  assert.deepEqual(view.rows[0], { label: "Last request", value: "0% hit · 0 read" });
  assert.deepEqual(view.rows[1], { label: "Session", value: "0% · 1 req" });
  assert.deepEqual(view.rows[2], { label: "Miss", value: "15k new · 3.0k written" });
  assert.deepEqual(cacheWebView(undefined, emptyTotals()), {
    title: "Cache",
    rows: [{ label: "Status", value: "No prompt-cache data yet" }],
  });
});

test("the extension publishes after each successful assistant message only", () => {
  const handlers: Record<string, (event: any) => void> = {};
  const offers: SectionOffer["section"][] = [];
  const webViews: Array<{ pluginId: string; view: { type: string; title?: string; rows?: Array<{ label: string }> } }> = [];
  const bus = {
    emit: (name: string, data: SectionOffer | { pluginId: string; view: { type: string; title?: string; rows?: Array<{ label: string }> } }) => {
      if (name === SECTION_EVENT) offers.push((data as SectionOffer).section);
      if (name === WEB_PLUGIN_VIEW_EVENT) webViews.push(data as typeof webViews[number]);
    },
    on() {},
  };
  cacheStats({ on: (name: string, fn: any) => { handlers[name] = fn; }, events: bus } as never);

  handlers.session_start!({});
  assert.equal(offers.at(-1)!.rows.length, 0, "hidden until a provider reports usage");
  assert.equal(webViews.length, 0, "no web view until a provider reports usage");
  handlers.message_end!({ message: { role: "user" } });
  handlers.message_end!({ message: { role: "assistant", stopReason: "error", usage: { input: 9000 } } });
  assert.equal(offers.at(-1)!.rows.length, 0, "failed and non-assistant messages are ignored");
  assert.equal(webViews.length, 0, "failed messages publish no web view");
  handlers.message_end!({ message: { role: "assistant", stopReason: "stop", usage: { input: 500, cacheRead: 9500 } } });
  const shown = offers.at(-1)!;
  assert.equal(shown.id, "cache");
  assert.equal(shown.title, "Cache 95%");
  assert.equal(webViews.length, 1);
  assert.equal(webViews[0].pluginId, "cache-stats");
  assert.equal(webViews[0].view.type, "kv");
  assert.equal(webViews[0].view.title, "Cache 95%");
  assert.equal(webViews[0].view.rows![0].label, "Last request");
  handlers.session_start!({});
  assert.equal(offers.at(-1)!.rows.length, 0, "a new session starts from zero");
  assert.equal(webViews.length, 1, "a new session does not republish stale data");
});
