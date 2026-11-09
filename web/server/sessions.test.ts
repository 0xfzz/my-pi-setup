import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSessionsForTests,
  listDiskSessions,
  parseSessionCommand,
  readHistory,
  registerSession,
  resolveSessionFile,
  sendCommand,
  type SessionCore,
  type SessionStateLite,
} from "./sessions.ts";

function fakeCore(overrides: Partial<SessionCore> & { sessionId?: string } = {}): SessionCore {
  const sessionId = overrides.sessionId ?? "fake-session";
  const state: SessionStateLite = {
    sessionId,
    sessionFile: "",
    isStreaming: false,
    isBashRunning: false,
    isCompacting: false,
    model: undefined,
    contextUsage: null,
    thinkingLevel: "off",
  };
  return {
    sessionId,
    subscribe: () => () => {},
    prompt: async () => {},
    abort: async () => {},
    isStreaming: () => false,
    getState: () => state,
    ...overrides,
  };
}

test.afterEach(() => {
  clearSessionsForTests();
});

test("parseSessionCommand accepts prompt, abort and get_state", () => {
  assert.deepEqual(parseSessionCommand({ type: "prompt", message: "hello" }), {
    type: "prompt",
    message: "hello",
  });
  assert.deepEqual(parseSessionCommand({ type: "abort" }), { type: "abort" });
  assert.deepEqual(parseSessionCommand({ type: "get_state" }), { type: "get_state" });
});

test("parseSessionCommand rejects malformed commands", () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /body must be an object/],
    [{ type: "prompt" }, /requires a message/],
    [{ type: "prompt", message: "  " }, /non-empty message/],
    [{ type: "nonsense" }, /unknown command type/],
    [{}, /unknown command type/],
    [{ type: "prompt", message: "hi", images: "nope" }, /images must be an array/],
    [{ type: "prompt", message: "hi", images: [{ data: "x" }] }, /mimeType/],
    [{ type: "prompt", message: "hi", images: [{ data: "x", mimeType: "text/plain" }] }, /image\/\*/],
    [{ type: "prompt", message: "hi", images: Array.from({ length: 9 }, () => ({ data: "x", mimeType: "image/png" })) }, /too many images/],
  ];
  for (const [body, pattern] of cases) {
    const parsed = parseSessionCommand(body);
    assert.ok("error" in parsed, `expected an error for ${JSON.stringify(body)}`);
    assert.match(parsed.error, pattern);
  }
});

test("parseSessionCommand accepts image-only prompts", () => {
  const parsed = parseSessionCommand({
    type: "prompt",
    message: "",
    images: [{ data: "aGk=", mimeType: "image/png" }],
  });
  assert.ok(!("error" in parsed));
  assert.deepEqual(parsed, {
    type: "prompt",
    message: "",
    images: [{ data: "aGk=", mimeType: "image/png" }],
  });
});

test("sendCommand routes prompt to the core and reports acceptance", async () => {
  const prompts: string[] = [];
  registerSession(
    fakeCore({ prompt: async (text) => { prompts.push(text); } }),
    "/tmp/project",
  );
  const result = await sendCommand("fake-session", { type: "prompt", message: "hi" });
  assert.deepEqual(result, { status: "ok", data: { accepted: true } });
  assert.deepEqual(prompts, ["hi"]);
});

test("sendCommand refuses a prompt while bash is running", async () => {
  const state = {
    sessionId: "busy-session",
    sessionFile: "",
    isStreaming: false,
    isBashRunning: true,
    isCompacting: false,
    model: undefined,
    contextUsage: null,
    thinkingLevel: "off",
  };
  registerSession(
    fakeCore({ sessionId: "busy-session", getState: () => state, prompt: async () => {
      throw new Error("must not be called");
    } }),
    "/tmp/project",
  );
  const result = await sendCommand("busy-session", { type: "prompt", message: "hi" });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.error, /shell command is running/);
  }
});

test("sendCommand routes abort and get_state", async () => {
  let aborted = false;
  const state: SessionStateLite = {
    sessionId: "ops-session",
    sessionFile: "/tmp/s.jsonl",
    isStreaming: true,
    isBashRunning: false,
    isCompacting: false,
    model: { provider: "anthropic", id: "claude-sonnet" },
    contextUsage: { percent: 42, contextWindow: 200000, tokens: 84000 },
    thinkingLevel: "high",
  };
  registerSession(
    fakeCore({ sessionId: "ops-session", abort: async () => { aborted = true; }, getState: () => state }),
    "/tmp/project",
  );
  assert.deepEqual(await sendCommand("ops-session", { type: "abort" }), {
    status: "ok",
    data: { aborted: true },
  });
  assert.equal(aborted, true);
  assert.deepEqual(await sendCommand("ops-session", { type: "get_state" }), {
    status: "ok",
    data: state,
  });
});

test("sendCommand reports prompt failures without throwing", async () => {
  registerSession(
    fakeCore({ prompt: async () => { throw new Error("provider offline"); } }),
    "/tmp/project",
  );
  const result = await sendCommand("fake-session", { type: "prompt", message: "hi" });
  assert.deepEqual(result, { status: "error", error: "provider offline" });
});

test("sendCommand reports unknown sessions", async () => {
  const result = await sendCommand("no-such-session", { type: "get_state" });
  assert.deepEqual(result, { status: "not_found" });
});

test("readHistory parses entries and tool results, skipping other roles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-history-"));
  const file = join(dir, "2026-11-09T00-00-00-000Z_abcd1234.jsonl");
  await writeFile(
    file,
    [
      JSON.stringify({ type: "session", id: "abcd1234", cwd: "/tmp/x", timestamp: "2026-11-09T00:00:00Z" }),
      JSON.stringify({ type: "model_change", provider: "anthropic", modelId: "claude" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hello pi" } }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "pondering" },
            { type: "text", text: "hi back" },
            { type: "toolCall", toolCallId: "t1", name: "bash", rawInput: "ls" },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "bash",
          content: [{ type: "text", text: "plans.md" }, { type: "image", data: "x" }],
          isError: false,
        },
      }),
      JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "t2", content: "boom" , isError: true } }),
      JSON.stringify({ type: "message", message: { role: "system", content: "loadout" } }),
      "not json",
      "",
    ].join("\n"),
  );

  const history = await readHistory(file);
  assert.equal(history.entries.length, 2);
  assert.deepEqual(history.entries[0], { role: "user", blocks: [{ kind: "text", text: "hello pi" }] });
  assert.deepEqual(history.entries[1], {
    role: "assistant",
    blocks: [
      { kind: "thinking", thinking: "pondering" },
      { kind: "text", text: "hi back" },
      { kind: "toolCall", toolCallId: "t1", toolName: "bash", rawInput: "ls" },
    ],
  });
  // Tool results join to their calls by id; text plus image blocks.
  assert.deepEqual(history.toolResults.t1, {
    text: "plans.md",
    isError: false,
    images: [{ data: "x", mimeType: "image/png" }],
  });
  assert.deepEqual(history.toolResults.t2, { text: "boom", isError: true });
  assert.equal(Object.keys(history.toolResults).length, 2);
});

test("readHistory returns empty for missing files", async () => {
  assert.deepEqual(await readHistory("/no/such/file.jsonl"), { entries: [], toolResults: {} });
});

test("readHistory reads pi's on-disk shapes: toolCall id/name/arguments, images, bash executions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-history-"));
  const file = join(dir, "2026-11-09T00-00-00-000Z_abcd1234.jsonl");
  await writeFile(
    file,
    [
      JSON.stringify({ type: "session", id: "abcd1234", cwd: "/tmp/x", timestamp: "2026-11-09T00:00:00Z" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "see this" },
            { type: "image", data: "aGk=", mimeType: "image/jpeg" },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          stopReason: "aborted",
          content: [{ type: "toolCall", id: "call-9", name: "bash", arguments: { command: "echo hi" } }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-9",
          content: [{ type: "text", text: "hi" }],
          isError: false,
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "bashExecution", command: "git status", output: "clean", exitCode: 0, cancelled: false, truncated: false },
      }),
    ].join("\n"),
  );

  const history = await readHistory(file);
  assert.deepEqual(history.entries[0], {
    role: "user",
    blocks: [
      { kind: "text", text: "see this" },
      { kind: "image", data: "aGk=", mimeType: "image/jpeg" },
    ],
  });
  assert.deepEqual(history.entries[1], {
    role: "assistant",
    blocks: [{ kind: "toolCall", toolCallId: "call-9", toolName: "bash", rawInput: '{"command":"echo hi"}' }],
    aborted: true,
  });
  assert.deepEqual(history.entries[2], {
    role: "user",
    blocks: [{ kind: "bash", command: "git status", output: "clean", exitCode: 0 }],
  });
  assert.deepEqual(history.toolResults["call-9"], { text: "hi", isError: false });
});

test("listDiskSessions and resolveSessionFile scan the sessions dir", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-agent-"));
  const projectDir = join(agentDir, "sessions", "slug");
  await mkdir(projectDir, { recursive: true });
  const older = join(projectDir, "2026-11-08T00-00-00-000Z_aaaa1111.jsonl");
  const newer = join(projectDir, "2026-11-09T00-00-00-000Z_bbbb2222.jsonl");
  await writeFile(
    older,
    `${JSON.stringify({ type: "session", id: "aaaa1111", cwd: "/tmp/a" })}\n`,
  );
  await writeFile(
    newer,
    `${JSON.stringify({ type: "session", id: "bbbb2222", cwd: "/tmp/b" })}\n`,
  );
  // A file without a valid header is skipped.
  await writeFile(join(projectDir, "2026-11-09T01-00-00-000Z_broken.jsonl"), "junk\n");
  // Distinct mtimes: same-millisecond writes make the sort order undefined.
  const now = new Date();
  const past = new Date(now.getTime() - 10_000);
  await utimes(older, past, past);
  await utimes(newer, now, now);

  const listed = await listDiskSessions({ agentDir });
  assert.equal(listed.length, 2);
  assert.equal(listed[0].id, "bbbb2222", "newest first");
  assert.equal(listed[0].cwd, "/tmp/b");
  assert.equal(listed[1].id, "aaaa1111");

  assert.equal(await resolveSessionFile("bbbb2222", agentDir), newer);
  assert.equal(await resolveSessionFile("nope", agentDir), null);
  assert.equal(await resolveSessionFile("../escape", agentDir), null);
});
