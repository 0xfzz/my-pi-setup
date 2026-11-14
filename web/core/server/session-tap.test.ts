import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { EventTapRegistry, type TapEvent } from "../plugin-contracts/kernel/events.ts";
import {
  TAP_TEXT_LIMIT,
  projectTapEvent,
  publishSessionTapEvent,
  tapChannelFor,
} from "./session-tap.ts";

test("a message event carries role, block types and capped text — never the raw message", () => {
  const long = "x".repeat(TAP_TEXT_LIMIT + 50);
  const event = projectTapEvent("s1", "/repo", {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: long },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
      ],
    },
  });
  assert.equal(event?.channel, "session.message");
  assert.equal(event?.sessionId, "s1");
  assert.equal(event?.project, "/repo");
  assert.equal(event?.payload.role, "assistant");
  assert.deepEqual(event?.payload.blockTypes, ["text", "toolCall"]);
  assert.equal(String(event?.payload.text).length, TAP_TEXT_LIMIT + 1, "text is capped, with an ellipsis");
  assert.equal("message" in (event?.payload ?? {}), false);
});

test("a tool event keeps identity and outcome and drops the result body", () => {
  const event = projectTapEvent("s1", "/repo", {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bash",
    isError: true,
    result: { output: "z".repeat(100_000) },
  });
  assert.equal(event?.channel, "session.tool");
  assert.deepEqual(event?.payload, { toolCallId: "call-1", toolName: "bash", isError: true });
});

test("a nested tool call is published with its parent so a subscriber can filter it", () => {
  const event = projectTapEvent("s1", "/repo", {
    type: "tool_execution_start",
    toolCallId: "call-2",
    toolName: "read",
    parentToolCallId: "call-1",
  });
  assert.equal(event?.payload.parentToolCallId, "call-1");
});

test("only a bash execution entry is tap traffic; every other appended entry is dropped", () => {
  const ignored = projectTapEvent("s1", "/repo", { type: "entry_appended", entry: { message: { role: "user" } } });
  assert.equal(ignored, null);
  const bash = projectTapEvent("s1", "/repo", {
    type: "entry_appended",
    entry: { message: { role: "bashExecution", command: "ls", exitCode: 2, output: "boom" } },
  });
  assert.equal(bash?.channel, "session.tool");
  assert.deepEqual(bash?.payload, { command: "ls", exitCode: 2, cancelled: false, output: "boom" });
});

test("streaming deltas and malformed events are not tap traffic", () => {
  for (const raw of [
    { type: "message_update", assistantMessageEvent: { type: "text_delta" } },
    { type: "tool_execution_update", toolCallId: "call-1", partialResult: {} },
    { type: "unknown_event" },
    null,
    "not an event",
  ]) {
    assert.equal(projectTapEvent("s1", "/repo", raw), null, JSON.stringify(raw));
  }
  assert.equal(tapChannelFor("message_update"), null);
  assert.equal(tapChannelFor(undefined), null);
});

test("the tap is optional: no host means no projection and no delivery", () => {
  assert.doesNotThrow(() => publishSessionTapEvent(null, "s1", "/repo", { type: "message_end", message: {} }));
});

test("a subscribed plugin receives the projected event for its channel", async () => {
  const tap = new EventTapRegistry();
  const seen: TapEvent[] = [];
  tap.subscribe({ pluginId: "acme.watch", grants: [{ kind: "tap.pi-events", arg: "session.lifecycle" }] }, "session.lifecycle", (event) => {
    seen.push(event);
  });
  publishSessionTapEvent(tap, "s1", "/repo", { type: "agent_settled" });
  publishSessionTapEvent(tap, "s1", "/repo", { type: "message_update", assistantMessageEvent: {} });
  await tap.publish({ channel: "session.tool", sessionId: "s1", project: "/repo", type: "noop", payload: {} });
  assert.deepEqual(seen.map((event) => [event.type, event.sessionId]), [["agent_settled", "s1"]]);
});

test("the tap is wired into the one place every live session is observed", () => {
  // Source-level guard: this call site is what turns the registry into a live
  // seam, and a refactor that drops it would leave every test above green.
  const source = readFileSync(new URL("./sessions.ts", import.meta.url), "utf8");
  assert.match(source, /publishSessionTapEvent\(host\?\.events \?\? null, id, cwd, event\)/);
});
