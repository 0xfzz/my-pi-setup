import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSessionsForTests,
  listDiskSessions,
  parseSessionCommand,
  historyFromText,
  readHistory,
  tailStartOffset,
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

test("parseSessionCommand accepts and bounds web_command and mentions", () => {
  assert.deepEqual(parseSessionCommand({ type: "web_command", name: "compact" }), {
    type: "web_command",
    name: "compact",
  });
  assert.deepEqual(parseSessionCommand({ type: "web_command", name: "name", args: "new name" }), {
    type: "web_command",
    name: "name",
    args: "new name",
  });
  assert.ok("error" in parseSessionCommand({ type: "web_command" }));
  assert.ok("error" in parseSessionCommand({ type: "web_command", name: "with space" }));
  assert.ok("error" in parseSessionCommand({ type: "web_command", name: "../escape" }));

});

test("sendCommand routes web_command through the web channel, falling back to prompt text", async () => {
  // A bridged core: the channel forwards as-is.
  const webCommands: Array<{ name: string; args: string }> = [];
  registerSession(
    fakeCore({ webCommand: async (name, args) => { webCommands.push({ name, args }); } }),
    "/tmp/project",
  );
  const result = await sendCommand("fake-session", { type: "web_command", name: "name", args: "renamed" });
  assert.equal(result.status, "ok");
  assert.deepEqual(webCommands, [{ name: "name", args: "renamed" }]);

  // A bridged core has no compaction of its own: /compact rides the bridge
  // to the process that owns the session, like every other web command.
  await sendCommand("fake-session", { type: "web_command", name: "compact", args: "focus on code" });
  assert.deepEqual(webCommands[1], { name: "compact", args: "focus on code" });

  // An in-process core owns compaction: the browser's /compact runs here,
  // with no extension and no bus in the path.
  const compactions: Array<string | undefined> = [];
  registerSession(
    fakeCore({
      sessionId: "inproc",
      webCommand: async () => { throw new Error("compaction must not ride the bus in-process"); },
      compact: async (instructions) => { compactions.push(instructions); },
    }),
    "/tmp/project",
  );
  const inProcess = await sendCommand("inproc", { type: "web_command", name: "compact", args: "focus on code" });
  assert.deepEqual(inProcess, { status: "ok", data: { accepted: true } });
  assert.deepEqual(compactions, ["focus on code"]);

  // A failing compaction reports why — "Nothing to compact (session too
  // small)" is the ordinary case and the banner must be able to show it.
  registerSession(
    fakeCore({
      sessionId: "tiny",
      compact: async () => { throw new Error("Nothing to compact (session too small)"); },
    }),
    "/tmp/project",
  );
  const failed = await sendCommand("tiny", { type: "web_command", name: "compact" });
  assert.deepEqual(failed, { status: "error", error: "Nothing to compact (session too small)" });
});

test("sendCommand passes @mentions through as typed — the model reads them with pi's read tool", async () => {
  const prompts: string[] = [];
  registerSession(
    fakeCore({ prompt: async (text) => { prompts.push(text); } }),
    "/tmp/project",
  );
  const result = await sendCommand("fake-session", {
    type: "prompt",
    message: "what is in @answer.txt",
  });
  assert.deepEqual(result, { status: "ok", data: { accepted: true } });
  assert.deepEqual(prompts, ["what is in @answer.txt"]);
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
  // t2 has no matching call anywhere in the transcript: a result without a
  // rendered row is unusable, and the window must stay bounded to the
  // visible conversation — orphans drop.
  assert.equal(history.toolResults.t2, undefined);
  assert.equal(Object.keys(history.toolResults).length, 1);
});

test("readHistory keeps the compaction boundary — the transcript shows why the context shrank", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-history-"));
  const file = join(dir, "2026-11-09T00-00-00-000Z_comp1234.jsonl");
  await writeFile(
    file,
    [
      JSON.stringify({ type: "session", id: "comp1234", cwd: "/tmp/x", timestamp: "2026-11-09T00:00:00Z" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "first" } }),
      JSON.stringify({
        type: "compaction",
        id: "c1",
        parentId: "m2",
        timestamp: "2026-11-09T00:10:00Z",
        summary: "The user asked about the parser and then the tests.",
        firstKeptEntryId: "c1",
        tokensBefore: 128_000,
        details: { readFiles: ["a.ts"] },
        usage: { input: 10 },
        fromHook: false,
      }),
      JSON.stringify({ type: "message", message: { role: "user", content: "again" } }),
    ].join("\n"),
  );

  const history = await readHistory(file);
  assert.deepEqual(history.entries, [
    { role: "user", blocks: [{ kind: "text", text: "first" }] },
    {
      role: "compaction",
      blocks: [],
      summary: "The user asked about the parser and then the tests.",
      tokensBefore: 128_000,
    },
    { role: "user", blocks: [{ kind: "text", text: "again" }] },
  ]);
});

test("readHistory tolerates a compaction entry with no summary or token count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-history-"));
  const file = join(dir, "2026-11-09T00-00-00-000Z_comp5678.jsonl");
  await writeFile(file, JSON.stringify({ type: "compaction", id: "c1" }));

  const history = await readHistory(file);
  // An empty summary still marks the boundary: the marker is the point, and a
  // missing field must not drop the entry or crash the read.
  assert.deepEqual(history.entries, [{ role: "compaction", blocks: [], summary: "" }]);
});

test("readHistory returns the TAIL when the file exceeds the limit — long sessions stay synced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-history-"));
  const file = join(dir, "2026-11-09T00-00-00-000Z_tail12345.jsonl");
  // 250 user/assistant entries: a long working session. The visible window
  // is the LAST 200 — the newest user message and everything after it must
  // be there, or the web looks "not synced" after a reload.
  const lines = [
    JSON.stringify({ type: "session", id: "tail12345", cwd: "/tmp/x", timestamp: "2026-11-09T00:00:00Z" }),
  ];
  for (let i = 1; i <= 250; i++) {
    lines.push(
      JSON.stringify({
        type: "message",
        message: {
          role: i % 2 === 0 ? "assistant" : "user",
          content: [
            {
              type: "text",
              text: `entry ${i}`,
            },
          ],
        },
      }),
    );
  }
  await writeFile(file, lines.join("\n"));

  const history = await readHistory(file);
  assert.equal(history.entries.length, 200);
  // The head rolled off; the tail is exactly entries 51..250 in order.
  assert.deepEqual(history.entries[0], {
    role: "user",
    blocks: [{ kind: "text", text: "entry 51" }],
  });
  assert.deepEqual(history.entries[199], {
    role: "assistant",
    blocks: [{ kind: "text", text: "entry 250" }],
  });
  // The newest user message is visible — the sync invariant the window
  // exists to protect.
  const newestUser = [...history.entries].reverse().find((entry) => entry.role === "user");
  assert.deepEqual(newestUser?.blocks, [{ kind: "text", text: "entry 249" }]);
  // No entry from the head survives.
  assert.ok(!history.entries.some((entry) => JSON.stringify(entry).includes("entry 50")),
    "the first 50 entries rolled off");
});

test("readHistory drops tool results whose calls rolled off the window, keeps those inside it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-history-"));
  const file = join(dir, "2026-11-09T00-00-00-000Z_window123.jsonl");
  const lines: string[] = [
    JSON.stringify({ type: "session", id: "window123", cwd: "/tmp/x", timestamp: "2026-11-09T00:00:00Z" }),
  ];
  const toolCall = (id: string): string =>
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", toolCallId: id, name: "bash", rawInput: "true" }],
      },
    });
  const toolResult = (id: string, text: string): string =>
    JSON.stringify({
      type: "message",
      message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text }], isError: false },
    });
  // 200 filler entries (the default limit) push the early call+result out;
  // the late call+result stays inside.
  lines.push(toolCall("old-call"), toolResult("old-call", "old result"));
  for (let i = 0; i < 200; i++) {
    lines.push(
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: `filler ${i}` }] },
      }),
    );
  }
  lines.push(toolCall("new-call"), toolResult("new-call", "new result"));
  await writeFile(file, lines.join("\n"));

  const history = await readHistory(file);
  assert.equal(history.entries.length, 200);
  // The late call is the newest entry; its result joined it.
  assert.deepEqual(history.entries[199], {
    role: "assistant",
    blocks: [{ kind: "toolCall", toolCallId: "new-call", toolName: "bash", rawInput: "true" }],
  });
  assert.deepEqual(history.toolResults["new-call"], { text: "new result", isError: false });
  // The early call rolled off — its result must not linger.
  assert.equal(history.toolResults["old-call"], undefined);
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

test("readHistory keeps empty-bodied aborted and provider-error replies — the status is the content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-history-"));
  const file = join(dir, "2026-11-09T00-00-00-000Z_failed123.jsonl");
  await writeFile(
    file,
    [
      JSON.stringify({ type: "session", id: "failed123", cwd: "/tmp/x", timestamp: "2026-11-09T00:00:00Z" }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", stopReason: "error", errorMessage: "429 rate limit exceeded", content: [] },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", stopReason: "error", content: [] },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", stopReason: "aborted", content: [] },
      }),
      // A normal empty assistant reply has nothing to say and stays dropped.
      JSON.stringify({
        type: "message",
        message: { role: "assistant", stopReason: "stop", content: [] },
      }),
    ].join("\n"),
  );

  const history = await readHistory(file);
  assert.equal(history.entries.length, 3);
  assert.deepEqual(history.entries[0], { role: "assistant", blocks: [], error: "429 rate limit exceeded" });
  assert.deepEqual(history.entries[1], { role: "assistant", blocks: [], error: "provider error" });
  assert.deepEqual(history.entries[2], { role: "assistant", blocks: [], aborted: true });
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

test("listDiskSessions keeps reading past invalid newest files until the limit is filled", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-agent-"));
  const projectDir = join(agentDir, "sessions", "slug");
  await mkdir(projectDir, { recursive: true });
  const base = Date.now();
  // Three valid sessions, oldest first.
  for (const [index, id] of ["aaaa1111", "bbbb2222", "cccc3333"].entries()) {
    const file = join(projectDir, `2026-11-0${index + 1}T00-00-00-000Z_${id}.jsonl`);
    await writeFile(file, `${JSON.stringify({ type: "session", id, cwd: `/tmp/${id}` })}\n`);
    const at = new Date(base - 100_000 + index * 1000);
    await utimes(file, at, at);
  }
  // Five newer files without a valid header: they must not use up the limit.
  for (let index = 0; index < 5; index++) {
    const file = join(projectDir, `2026-11-10T00-00-0${index}-000Z_junk${index}.jsonl`);
    await writeFile(file, "not a header\n");
    const at = new Date(base - index * 1000);
    await utimes(file, at, at);
  }

  const listed = await listDiskSessions({ agentDir, limit: 2 });
  assert.deepEqual(listed.map((session) => session.id), ["cccc3333", "bbbb2222"], "the two newest valid sessions, newest first");
});

/** A long session: user and assistant turns, tool calls with their results, a compaction and a `!` command. */
function longSessionText(entries: number): string {
  const lines = [JSON.stringify({ type: "session", id: "longsess", cwd: "/tmp/long" })];
  const padding = "x".repeat(2_000);
  for (let index = 0; index < entries; index++) {
    if (index % 400 === 0) lines.push(JSON.stringify({ type: "compaction", summary: `summary ${index}`, tokensBefore: index }));
    if (index % 150 === 7) {
      lines.push(JSON.stringify({ type: "message", message: { role: "bashExecution", command: `ls ${index}`, output: padding.slice(0, 50), exitCode: 0 } }));
      continue;
    }
    if (index % 3 === 0) {
      lines.push(JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `ask ${index} ${padding}` }] } }));
      continue;
    }
    if (index % 3 === 1) {
      lines.push(JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: `working ${index}` }, { type: "toolCall", id: `call-${index}`, name: "bash", arguments: { cmd: "ls" } }] } }));
      continue;
    }
    lines.push(JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: `call-${index - 1}`, toolName: "bash", isError: false, content: [{ type: "text", text: `out ${index} ${padding}` }] } }));
  }
  return `${lines.join("\n")}\n`;
}

test("readHistory over a file larger than its first read returns exactly the whole-file window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-history-tail-"));
  try {
    const file = join(dir, "long.jsonl");
    const text = longSessionText(2_500);
    await writeFile(file, text);
    // Larger than the first tail read, so a small window reads only the tail and a window past the first read doubles it.
    assert.ok(Buffer.byteLength(text) > 1024 * 1024, "the fixture is larger than the first tail read");
    for (const limit of [1, 3, 25, 200, 2_600]) {
      const tail = await readHistory(file, limit);
      assert.deepEqual(tail, historyFromText(text, limit), `limit ${limit}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readHistory on a session with fewer entries than the limit returns every entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-history-short-"));
  try {
    const file = join(dir, "short.jsonl");
    const text = longSessionText(12);
    await writeFile(file, text);
    assert.deepEqual(await readHistory(file, 200), historyFromText(text, 200));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tailStartOffset starts at the line that begins the newest N entry lines, skipping other lines, and is 0 when there are fewer", () => {
  const lines = [
    '{"type":"session","id":"x"}',
    '{"type":"message","n":1}',
    '{"type":"model_change","n":9}',
    '{"type":"compaction","n":2}',
    '{"type":"message","message":{"role":"toolResult","toolCallId":"c"}}',
    '{"type":"message","n":3}',
    "",
  ];
  const buffer = Buffer.from(lines.join("\n"));
  const startOf = (line: string) => buffer.indexOf(line);
  // A tool result is a message line but not a window entry, so it never starts the window.
  assert.equal(tailStartOffset(buffer, 1), startOf('{"type":"message","n":3}'));
  assert.equal(tailStartOffset(buffer, 2), startOf('{"type":"compaction","n":2}'));
  assert.equal(tailStartOffset(buffer, 3), startOf('{"type":"message","n":1}'));
  assert.equal(tailStartOffset(buffer, 4), 0, "fewer entry lines than asked: the whole text");
});
