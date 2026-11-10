import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_TITLE_ASSISTANT_CHARS,
  AUTO_TITLE_USER_CHARS,
  buildTitlePrompt,
  cleanGeneratedTitle,
  firstExchange,
  generateAutoTitle,
} from "../lib/auto-title.ts";

const user = (content: unknown) => ({ type: "message", message: { role: "user", content } });
const assistant = (content: unknown) => ({ type: "message", message: { role: "assistant", content } });

test("firstExchange takes only the first user and first assistant text", () => {
  const branch = [
    user("fix the login bug"),
    assistant([{ type: "thinking", thinking: "hmm" }, { type: "toolCall", name: "read" }]),
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "TOOL OUTPUT" }] } },
    assistant([{ type: "text", text: "Found it in auth.ts" }]),
    user("second question"),
  ];
  assert.deepEqual(firstExchange(branch), { user: "fix the login bug", assistant: "Found it in auth.ts" });
});

test("firstExchange tolerates a missing reply, array content and non-message entries", () => {
  assert.equal(firstExchange([]), undefined);
  assert.equal(firstExchange([{ type: "custom", customType: "x" }]), undefined);
  assert.deepEqual(
    firstExchange([{ type: "custom" }, user([{ type: "text", text: "hello" }, { type: "image" }])]),
    { user: "hello", assistant: "" },
  );
});

test("firstExchange clips long text so the request stays small", () => {
  const exchange = firstExchange([user("a ".repeat(5_000)), assistant("b ".repeat(5_000))])!;
  assert.ok(exchange.user.length <= AUTO_TITLE_USER_CHARS + 1);
  assert.ok(exchange.assistant.length <= AUTO_TITLE_ASSISTANT_CHARS + 1);
});

test("buildTitlePrompt omits the reply block when there is none", () => {
  assert.equal(buildTitlePrompt({ user: "hi", assistant: "" }), "<user_message>hi</user_message>\nTitle:");
  assert.match(buildTitlePrompt({ user: "hi", assistant: "yo" }), /<assistant_reply>yo<\/assistant_reply>/);
});

test("cleanGeneratedTitle normalises model output", () => {
  assert.equal(cleanGeneratedTitle('"Fix Login Email Validation."'), "Fix Login Email Validation");
  assert.equal(cleanGeneratedTitle("Title: Setup JWT Auth\nextra explanation"), "Setup JWT Auth");
  assert.equal(cleanGeneratedTitle("## **Dashboard polish**"), "Dashboard polish");
  assert.equal(cleanGeneratedTitle("\n\n  `Refactor DB pooling`  "), "Refactor DB pooling");
});

test("cleanGeneratedTitle rejects unusable output", () => {
  assert.equal(cleanGeneratedTitle(""), "");
  assert.equal(cleanGeneratedTitle("   "), "");
  assert.equal(cleanGeneratedTitle(undefined), "");
  assert.equal(cleanGeneratedTitle("aa2e0e1c-1c2b-4d3e-8f90-0123456789ab"), "");
  assert.equal(cleanGeneratedTitle("untitled"), "");
  assert.equal(cleanGeneratedTitle("one two three four five six seven eight nine ten"), "");
});

test("generateAutoTitle sends one bounded request and returns the cleaned title", async () => {
  const requests: any[] = [];
  const title = await generateAutoTitle({
    branch: [user("install this extension"), assistant([{ type: "text", text: "Installing now" }])],
    complete: async (request) => {
      requests.push(request);
      return '"Install Permission Extension"\n';
    },
  });
  assert.equal(title, "Install Permission Extension");
  assert.equal(requests.length, 1);
  assert.ok(requests[0].maxTokens <= 256);
  assert.match(requests[0].prompt, /install this extension/);
  assert.match(requests[0].prompt, /Installing now/);
});

test("generateAutoTitle makes no request without a user message and propagates failures", async () => {
  let calls = 0;
  const complete = async () => {
    calls++;
    throw new Error("boom");
  };
  assert.equal(await generateAutoTitle({ branch: [], complete }), "");
  assert.equal(calls, 0);
  await assert.rejects(generateAutoTitle({ branch: [user("hi")], complete }), /boom/);
});
