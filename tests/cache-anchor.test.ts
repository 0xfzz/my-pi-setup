import test from "node:test";
import assert from "node:assert/strict";
import {
  lastCachePlan,
  markVolatileTail,
  planCacheBreakpoints,
  resetCachePlan,
} from "../lib/cache-anchor.ts";

const CC = { type: "ephemeral" };
const count = (payload: unknown): number => JSON.stringify(payload).split('"cache_control"').length - 1;
const lastBlocks = (payload: any): any[] => payload.messages[payload.messages.length - 1].content;

/** The payload `convertMessages` builds: string prompts, block arrays for the rest. */
const request = (messages: unknown[], extra: Record<string, unknown> = {}): any => ({
  tools: [{ name: "read", cache_control: CC }],
  system: [{ type: "text", text: "sys", cache_control: CC }],
  messages,
  ...extra,
});

const tail = (text: string): any => ({ role: "user", content: [{ type: "text", text }] });

test("the conversation marker moves off the tail and the prompt gains one", () => {
  const catalog = markVolatileTail("<artifacts>catalog v7</artifacts>");
  const payload = request([
    { role: "user", content: "do the thing" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
      { type: "text", text: catalog, cache_control: CC },
    ] },
  ]);

  const plan = planCacheBreakpoints(payload);

  assert.equal(plan.pin, true);
  assert.equal(plan.rolling, true);
  assert.equal(plan.placed, 4, "system + tool + prompt + last stable block");
  assert.equal(plan.skipped, undefined);
  const blocks = payload.messages[2].content;
  assert.equal(blocks[1].cache_control, undefined, "the request-local block no longer carries it");
  assert.deepEqual(blocks[0].cache_control, CC, "the stable tool_result does");
  assert.deepEqual(payload.messages[0].content, [{ type: "text", text: "do the thing", cache_control: CC }]);
  assert.equal(count(payload), 4);
});

test("an OAuth request gives up its redundant identity marker instead of exceeding four", () => {
  markVolatileTail("tail for the oauth case");
  const payload = {
    // Pi marks both system blocks for OAuth: the identity, then the real prompt.
    system: [
      { type: "text", text: "You are Claude Code", cache_control: CC },
      { type: "text", text: "pi's prompt", cache_control: CC },
    ],
    tools: [{ name: "read", cache_control: CC }],
    messages: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      tail("tail for the oauth case"),
    ],
  };

  const plan = planCacheBreakpoints(payload);

  assert.equal(plan.dropped, 1);
  assert.equal(payload.system[0].cache_control, undefined, "the identity prefix is a subset of the next block");
  assert.deepEqual(payload.system[1].cache_control, CC);
  assert.equal(plan.placed, 4);
  assert.equal(count(payload), 4, "Anthropic rejects a fifth marker");
});

test("stacked request-local messages are all skipped, across message boundaries", () => {
  const first = markVolatileTail("todo line");
  const second = markVolatileTail("checkpoint snapshot");
  const payload = request([
    { role: "user", content: "start" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    tail(first),
    tail(second),
  ]);

  const plan = planCacheBreakpoints(payload);

  assert.equal(plan.pin, true);
  assert.equal(plan.rolling, true);
  assert.equal(payload.messages[3].content[0].cache_control, undefined);
  assert.equal(payload.messages[4].content[0].cache_control, undefined, "the marker no longer lands on a tail");
  assert.deepEqual(payload.messages[2].content[0].cache_control, CC);
  assert.deepEqual(payload.messages[0].content[0].cache_control, CC, "the prompt is pinned");
  assert.equal(count(payload), 4);
});

test("the prompt stays pinned when a turn appends more blocks than the lookback window", () => {
  const calls = Array.from({ length: 15 }, (_, index) => index);
  const payload = request([
    { role: "user", content: "work through these" },
    { role: "assistant", content: calls.map((index) => ({ type: "tool_use", id: `t${index}`, name: "read", input: {} })) },
    { role: "user", content: calls.map((index) => ({ type: "tool_result", tool_use_id: `t${index}`, content: "ok" })) },
    tail(markVolatileTail("late tail")),
  ]);

  const plan = planCacheBreakpoints(payload);

  assert.equal(plan.pin, true);
  assert.equal(plan.rolling, true);
  assert.deepEqual(payload.messages[0].content[0].cache_control, CC, ">20 blocks from the end, still pinned");
  assert.deepEqual(payload.messages[2].content.at(-1).cache_control, CC, "and still rolling at the true end");
  const trailing = payload.messages.slice(1).reduce((sum: number, message: any) => sum + message.content.length, 0);
  assert.ok(trailing > 20, `the pin is ${trailing} blocks from the end, past the lookback window`);
});

test("the last prompt is pinned even after the assistant has answered", () => {
  const reminder = markVolatileTail("<current-input-mode>\nplan\n</current-input-mode>");
  const payload = request([
    { role: "user", content: "earlier" },
    { role: "assistant", content: [{ type: "text", text: "answer" }] },
    tail(reminder),
  ]);

  const plan = planCacheBreakpoints(payload);

  assert.equal(plan.pin, true);
  assert.equal(plan.rolling, true, "the assistant's answer is where the conversation ends");
  assert.equal(plan.skipped, undefined);
  assert.deepEqual(payload.messages[0].content, [{ type: "text", text: "earlier", cache_control: CC }]);
  assert.deepEqual(payload.messages[1].content[0].cache_control, CC);
  assert.equal(payload.messages[2].content[0].cache_control, undefined);
});

test("a tail directly after a thinking block leaves the marker where Pi put it", () => {
  const reminder = markVolatileTail("tail after thinking");
  const payload = {
    messages: [
      { role: "assistant", content: [{ type: "thinking", thinking: "..." }] },
      { role: "user", content: [{ type: "text", text: reminder, cache_control: CC }] },
    ],
  };
  const before = JSON.stringify(payload);

  const plan = planCacheBreakpoints(payload);

  assert.equal(plan.placed, 0);
  assert.equal(plan.skipped, "no prompt");
  assert.equal(JSON.stringify(payload), before, "nothing better exists, so nothing is rewritten");
});

test("a request with no marker is never opted into caching", () => {
  const payload = { max_tokens: 100, messages: [{ role: "user", content: "hi" }] };
  const before = JSON.stringify(payload);

  const plan = planCacheBreakpoints(payload);

  assert.equal(plan.placed, 0);
  assert.equal(plan.skipped, "no markers");
  assert.equal(JSON.stringify(payload), before);
  assert.equal(planCacheBreakpoints({ input: "responses api" }).skipped, "no markers");
  assert.equal(planCacheBreakpoints(undefined).skipped, "no markers");
});

test("a payload the plan cannot improve is left byte-identical", () => {
  const payload = {
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "hi", cache_control: CC }] },
    ],
  };
  const before = JSON.stringify(payload);

  planCacheBreakpoints(payload);

  assert.equal(JSON.stringify(payload), before, "the prompt is already the marked block");
});

test("planning twice is a no-op", () => {
  const catalog = markVolatileTail("<artifacts>catalog v8</artifacts>");
  const payload = request([
    { role: "user", content: "do the thing" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    tail(catalog),
  ]);

  planCacheBreakpoints(payload);
  const once = JSON.stringify(payload);
  const plan = planCacheBreakpoints(payload);

  assert.equal(JSON.stringify(payload), once);
  assert.equal(plan.placed, 4);
  assert.equal(plan.dropped, 0);
});

test("the registry keeps the newest texts and the last plan is readable", () => {
  const kept = markVolatileTail("twice marked");
  markVolatileTail("twice marked");
  const payload = request([
    { role: "user", content: "go" },
    tail(kept),
  ]);
  assert.equal(lastBlocks(payload).length, 1);

  const plan = planCacheBreakpoints(payload);
  assert.equal(lastCachePlan(), plan, "the sidebar reads the plan the request produced");
  resetCachePlan();
  assert.equal(lastCachePlan(), undefined);
});
