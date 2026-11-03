import test from "node:test";
import assert from "node:assert/strict";
import cacheBreakpoints from "../extensions/cache-breakpoints.ts";
import cacheStats from "../extensions/cache-stats.ts";
import { markVolatileTail } from "../lib/cache-anchor.ts";
import { SECTION_EVENT, type SectionOffer } from "../lib/sidebar/sidebar-channel.ts";

const CC = { type: "ephemeral" };

function wire(extension: (pi: never) => void) {
  const handlers: Record<string, (event: any) => any> = {};
  const offers: SectionOffer["section"][] = [];
  const bus = {
    emit: (name: string, data: SectionOffer) => { if (name === SECTION_EVENT) offers.push(data.section); },
    on() {},
  };
  extension({ on: (name: string, fn: any) => { handlers[name] = fn; }, events: bus } as never);
  return { handlers, offers };
}

/** A mid-turn request whose last message is the request-local tail Pi marked. */
const tailedRequest = (volatile: string): any => ({
  system: [{ type: "text", text: "sys", cache_control: CC }],
  tools: [{ name: "read", cache_control: CC }],
  messages: [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    { role: "user", content: [{ type: "text", text: volatile, cache_control: CC }] },
  ],
});

test("the extension moves the conversation marker off the request-local tail", () => {
  const payload = tailedRequest(markVolatileTail("<artifacts>catalog</artifacts>"));
  const { handlers } = wire(cacheBreakpoints);

  const returned = handlers.before_provider_request!({ payload });

  assert.equal(returned, payload, "the payload is mutated in place, not replaced");
  assert.equal(payload.messages[3].content[0].cache_control, undefined, "nothing is cached on the tail");
  assert.deepEqual(payload.messages[2].content[0].cache_control, CC, "the conversation ends at the tool_result");
  assert.deepEqual(payload.messages[0].content, [{ type: "text", text: "go", cache_control: CC }]);
});

test("a plan that could not pin a prompt is reported in the cache section", () => {
  const { handlers: stats, offers } = wire(cacheStats);
  stats.session_start!({});

  const reminder = markVolatileTail("tail after a thinking block");
  const { handlers: breakpoints } = wire(cacheBreakpoints);
  breakpoints.before_provider_request!({ payload: { messages: [
    { role: "assistant", content: [{ type: "thinking", thinking: "..." }] },
    { role: "user", content: [{ type: "text", text: reminder, cache_control: CC }] },
  ] } });

  stats.message_end!({ message: { role: "assistant", stopReason: "stop", usage: { input: 500, cacheRead: 9500 } } });

  const rows = offers.at(-1)!.rows;
  assert.equal(rows.at(-1), "breakpoint: no prompt", "a silent regression is exactly what this row exists for");
});

test("a complete plan adds no row of its own", () => {
  const { handlers: stats, offers } = wire(cacheStats);
  stats.session_start!({});
  const { handlers: breakpoints } = wire(cacheBreakpoints);
  breakpoints.before_provider_request!({ payload: tailedRequest(markVolatileTail("a marked tail")) });

  stats.message_end!({ message: { role: "assistant", stopReason: "stop", usage: { input: 500, cacheRead: 9500 } } });

  const rows = offers.at(-1)!.rows;
  assert.equal(rows.some((row) => row.startsWith("breakpoint:")), false);
  assert.match(rows[0]!, /^last 95% hit · 9\.5k read$/);
});

test("a new session forgets the previous plan", () => {
  const { handlers: stats, offers } = wire(cacheStats);
  const { handlers: breakpoints } = wire(cacheBreakpoints);
  breakpoints.before_provider_request!({ payload: { messages: [
    { role: "assistant", content: [{ type: "thinking", thinking: "..." }] },
    { role: "user", content: [{ type: "text", text: markVolatileTail("stale tail"), cache_control: CC }] },
  ] } });
  stats.session_start!({});
  stats.message_end!({ message: { role: "assistant", stopReason: "stop", usage: { input: 300, cacheRead: 9700 } } });

  assert.equal(offers.at(-1)!.rows.some((row) => row.startsWith("breakpoint:")), false);
});
