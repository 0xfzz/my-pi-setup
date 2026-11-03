import test from "node:test";
import assert from "node:assert/strict";
import { addSample, cacheRows, emptyTotals, isCostlyMiss, sampleOf, tokens } from "../lib/cache-stats.ts";
import cacheStats from "../extensions/cache-stats.ts";
import { SECTION_EVENT, type SectionOffer } from "../lib/sidebar/sidebar-channel.ts";

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

test("the extension publishes after each successful assistant message only", () => {
  const handlers: Record<string, (event: any) => void> = {};
  const offers: SectionOffer["section"][] = [];
  const bus = { emit: (name: string, data: SectionOffer) => { if (name === SECTION_EVENT) offers.push(data.section); }, on() {} };
  cacheStats({ on: (name: string, fn: any) => { handlers[name] = fn; }, events: bus } as never);

  handlers.session_start!({});
  assert.equal(offers.at(-1)!.rows.length, 0, "hidden until a provider reports usage");
  handlers.message_end!({ message: { role: "user" } });
  handlers.message_end!({ message: { role: "assistant", stopReason: "error", usage: { input: 9000 } } });
  assert.equal(offers.at(-1)!.rows.length, 0, "failed and non-assistant messages are ignored");
  handlers.message_end!({ message: { role: "assistant", stopReason: "stop", usage: { input: 500, cacheRead: 9500 } } });
  const shown = offers.at(-1)!;
  assert.equal(shown.id, "cache");
  assert.equal(shown.title, "Cache 95%");
  handlers.session_start!({});
  assert.equal(offers.at(-1)!.rows.length, 0, "a new session starts from zero");
});
