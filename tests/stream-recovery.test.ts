import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import extension from "../extensions/stream-recovery.ts";
import { completeLines, interruptedArguments, isStreamDisconnect, MAX_DRAFT_BYTES, recoveryContext } from "../lib/stream-recovery.ts";

function harness(cwd: string, branch: any[] = []) {
  const hooks = new Map<string, Function>();
  let tool: any;
  let command: any;
  const sent: any[] = [];
  const notices: string[] = [];
  const executed: any[] = [];
  const ctx: any = {
    cwd, hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getBranch: () => branch },
    ui: { notify: (text: string) => notices.push(text) },
    executeTool: async (name: string, args: any) => {
      executed.push({ name, args });
      if (name === "write") await writeFile(resolve(cwd, args.path.replace(/^@/, "")), args.content);
      return { isError: false, result: { content: [{ type: "text", text: "original result" }], details: { original: true } } };
    },
  };
  extension({
    on: (name: string, handler: Function) => hooks.set(name, handler),
    registerTool: (value: any) => { tool = value; },
    registerCommand: (_name: string, value: any) => { command = value; },
    appendEntry: (customType: string, data: any) => branch.push({ type: "custom", customType, data: structuredClone(data) }),
    sendMessage: (...args: any[]) => sent.push(args),
    sendUserMessage: (...args: any[]) => sent.push(args),
  } as any);
  const emit = (name: string, event: any = {}) => hooks.get(name)!(event, ctx);
  const interrupted = (name: string, args: any, options: any = {}) => emit("message_end", { message: {
    role: "assistant", timestamp: options.timestamp ?? 1, stopReason: "error", errorMessage: "upstream stream ended before completion",
    content: [{ type: "toolCall", id: options.id ?? "partial", name, arguments: args }], ...options,
  } });
  const context = () => emit("context", { messages: [] })?.messages.at(-1)?.content ?? "";
  const latest = () => branch.filter(entry => entry.data?.draft).at(-1)?.data.draft;
  const run = (args: any, signal?: AbortSignal) => tool.execute("resume", args, signal, undefined, ctx);
  return { branch, ctx, hooks, sent, notices, executed, emit, interrupted, context, latest, run, command };
}

async function withDirectory(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-stream-recovery-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("only complete lines survive repaired trailing escapes; errors are narrowly classified", () => {
  assert.equal(completeLines("alpha\npartial\\uD8"), "alpha\n");
  assert.equal(completeLines("single unfinished command"), "");
  assert.equal(completeLines("one\r\ntwo\n"), "one\r\ntwo\n");
  for (const error of ["upstream stream ended before completion", "socket closed", "ECONNRESET", "terminated"]) assert.equal(isStreamDisconnect(error), true);
  for (const error of ["401 invalid key", "quota exceeded", "Operation aborted", "maximum context length exceeded", "stream terminated: quota exceeded"]) assert.equal(isStreamDisconnect(error), false);
});

test("large PRD interruption saves prefix, not target; suffix alone completes the file", () => withDirectory(async dir => {
  const h = harness(dir);
  const prefix = "# PRD\n" + "requirement: pluggable UI\n".repeat(800);
  await h.interrupted("write", { path: "prd.md", content: prefix + "unfinished line" });
  await assert.rejects(readFile(join(dir, "prd.md")), /ENOENT/);
  const draft = h.latest();
  assert.equal(draft.prefix, prefix);
  assert.match(h.context(), /NEVER executed/);
  assert.ok(h.context().length < 3000, "provider retries must not resend the entire 19KB draft");
  await h.run({ id: draft.id, version: 1, suffix: "final requirement\n", finish: true });
  assert.equal(await readFile(join(dir, "prd.md"), "utf8"), prefix + "final requirement\n");
  assert.equal(h.executed.length, 1);
  await assert.rejects(h.run({ id: draft.id, version: 1, suffix: "duplicate", finish: true }), /already consumed/);
  assert.equal(h.context(), "");
}));

test("another cut during recovery advances the saved draft without executing or duplicating chunks", () => withDirectory(async dir => {
  const h = harness(dir);
  await h.interrupted("write", { path: "a", content: "first\ncut" });
  const id = h.latest().id;
  await h.interrupted("recover_stream", { id, version: 1, finish: true, suffix: "second\nthird cut" }, { timestamp: 2 });
  assert.equal(h.latest().prefix, "first\nsecond\n");
  assert.equal(h.latest().version, 2);
  assert.equal(h.executed.length, 0);
  await assert.rejects(h.run({ id, version: 1, suffix: "second\n", finish: true }), /current version 2/);
  await h.run({ id, version: 2, suffix: "third\n", finish: false });
  assert.equal(h.latest().version, 3);
  await assert.rejects(h.run({ id, version: 3, suffix: "not a complete chunk", finish: false }), /newline/);
  await h.run({ id, version: 3, suffix: "last", finish: true });
  assert.equal(await readFile(join(dir, "a"), "utf8"), "first\nsecond\nthird\nlast");
}));

test("output-limit rejection keeps its error status but directs only captured calls to suffix recovery", () => withDirectory(async dir => {
  const h = harness(dir);
  await h.interrupted("write", { path: "a", content: "saved\ncut" }, { stopReason: "length" });
  const rejection = { role: "toolResult", toolCallId: "partial", toolName: "write", isError: true, timestamp: 42, content: [{ type: "text", text: "Re-issue the tool call with complete arguments." }] };
  const patched = await h.emit("message_end", { message: rejection });
  assert.equal(patched.message.isError, true);
  assert.equal(patched.message.timestamp, 42);
  assert.match(patched.message.content[0].text, /output token limit.*Saved prefix:/);
  assert.match(patched.message.content[0].text, /recover_stream/);
  assert.doesNotMatch(patched.message.content[0].text, /Re-issue the tool call with complete arguments/);
  assert.equal(await h.emit("message_end", { message: { ...rejection, toolCallId: "unrelated" } }), undefined);
  assert.equal(h.executed.length, 0);
  await assert.rejects(readFile(join(dir, "a")), /ENOENT/);
}));

test("another output limit can salvage malformed recovery arguments and advance the version", () => withDirectory(async dir => {
  const h = harness(dir);
  await h.interrupted("write", { path: "a", content: "first\ncut" }, { stopReason: "length" });
  const id = h.latest().id;
  const raw = JSON.stringify({ id, version: 1, finish: true, suffix: "second\nthird cut" }).slice(0, -2);
  await h.emit("message_start", { message: { role: "assistant" } });
  await h.interrupted("recover_stream", {}, {
    stopReason: "length", timestamp: 2,
    content: [{ type: "toolCall", id: "second-cut", name: "recover_stream", arguments: {}, argumentsError: `Unexpected end of JSON input\n\nReceived arguments:\n${raw}` }],
  });
  assert.equal(h.latest().prefix, "first\nsecond\n");
  assert.equal(h.latest().version, 2);
  assert.equal(h.executed.length, 0);
  const warning = await h.emit("message_end", { message: { role: "toolResult", toolCallId: "second-cut", toolName: "recover_stream", isError: true, content: [] } });
  assert.match(warning.message.content[0].text, /version 2/);
  await h.run({ id, version: 2, finish: true, suffix: "third" });
  assert.equal(await readFile(join(dir, "a"), "utf8"), "first\nsecond\nthird");
}));

test("aborted streamed arguments are discarded, not resurrected by a later length failure", () => withDirectory(async dir => {
  const h = harness(dir);
  const call = { type: "toolCall", id: "partial", name: "write", arguments: {}, argumentsError: "Unexpected end of JSON input" };
  await h.emit("message_start", { message: { role: "assistant" } });
  await h.emit("message_update", { message: { role: "assistant", content: [call] }, assistantMessageEvent: {
    type: "toolcall_delta", contentIndex: 0, delta: '{"path":"a","content":"saved\\ncut',
  } });
  await h.interrupted("write", {}, { stopReason: "aborted", content: [call] });
  await h.interrupted("write", {}, { stopReason: "length", content: [call] });
  assert.equal(h.latest(), undefined);
  assert.equal(h.executed.length, 0);
}));

test("argument salvage rejects malformed or over-budget data and prefers finalized diagnostics", () => {
  assert.equal(interruptedArguments({ arguments: {}, argumentsError: "invalid" }), undefined);
  assert.equal(interruptedArguments({ arguments: {} }, '"not an object"'), undefined);
  assert.equal(interruptedArguments({ arguments: {} }, " ".repeat(8 * MAX_DRAFT_BYTES + 1)), undefined);
  assert.deepEqual(interruptedArguments({ arguments: {}, argumentsError: 'invalid\n\nReceived arguments:\n{"path":"a","content":"kept\\ncut' }, '{"path":"wrong"'), { path: "a", content: "kept\ncut" });
});

test("parallel finalizers cannot consume the same write draft twice", () => withDirectory(async dir => {
  const h = harness(dir);
  await h.interrupted("write", { path: "a", content: "first\ncut" });
  const id = h.latest().id;
  const results = await Promise.allSettled([
    h.run({ id, version: 1, suffix: "one", finish: true }),
    h.run({ id, version: 1, suffix: "two", finish: true }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(h.executed.length, 1);
}));

test("bash heredoc is staged only; finishing uses the original dispatcher and timeout", () => withDirectory(async dir => {
  const h = harness(dir);
  await h.interrupted("bash", { command: "printf '%s' \"\nhello\n", timeout: 23 });
  const draft = h.latest();
  assert.equal(h.executed.length, 0);
  await h.run({ id: draft.id, version: 1, suffix: "world\n", finish: false });
  assert.equal(h.executed.length, 0);
  await h.run({ id: draft.id, version: 2, suffix: "\"", finish: true });
  assert.deepEqual(h.executed, [{ name: "bash", args: { command: "printf '%s' \"\nhello\nworld\n\"", timeout: 23 } }]);
}));

test("blocked/failed/uncertain execution consumes a draft, including after reload", () => withDirectory(async dir => {
  for (const fail of [false, true]) {
    const h = harness(dir);
    await h.interrupted("bash", { command: "echo start\npartial" });
    const id = h.latest().id;
    h.ctx.executeTool = async () => {
      assert.equal(h.latest().status, "executing", "at-most-once marker precedes side effects");
      if (fail) throw new Error("lost connection during execute");
      return { isError: true, result: { content: [{ type: "text", text: "blocked" }], details: {} } };
    };
    if (fail) await assert.rejects(h.run({ id, version: 1, suffix: "echo end", finish: true }), /lost connection/);
    else assert.equal((await h.run({ id, version: 1, suffix: "echo end", finish: true })).isError, true);
    const restored = harness(dir, h.branch);
    await restored.emit("session_start");
    await assert.rejects(restored.run({ id, version: 1, suffix: "echo end", finish: true }), /already consumed/);
  }
}));

test("changed files and cancellation are not overwritten; normal successful writes retire old drafts", () => withDirectory(async dir => {
  await writeFile(join(dir, "a"), "original");
  const h = harness(dir);
  await h.interrupted("write", { path: "@a", content: "new\ncut" });
  const id = h.latest().id;
  await writeFile(join(dir, "a"), "user edit");
  await assert.rejects(h.run({ id, version: 1, suffix: "end", finish: true }), /Target file changed/);
  assert.equal(await readFile(join(dir, "a"), "utf8"), "user edit");
  await assert.rejects(h.run({ id, version: 1, suffix: "end", finish: true }, AbortSignal.abort()), /cancelled/);
  h.ctx.cwd = dir + "/other";
  await assert.rejects(h.run({ id }), /different working directory/);
  h.ctx.cwd = dir;
  await h.emit("tool_result", { toolName: "write", input: { path: "a" }, isError: false });
  assert.equal(h.context(), "");
}));

test("reload and branch navigation restore only branch drafts; off persists", () => withDirectory(async dir => {
  const h = harness(dir);
  await h.interrupted("write", { path: "a", content: "kept\ncut" });
  await h.command.handler("off", h.ctx);
  const restored = harness(dir, h.branch);
  await restored.emit("session_start");
  assert.match(restored.context(), /kept/);
  await restored.command.handler("status", restored.ctx);
  assert.match(restored.sent.at(-1)[0].content, /recovery: off/);
  restored.branch.splice(0);
  await restored.emit("session_tree");
  assert.equal(restored.context(), "");
}));

test("aborted, successful, malformed, unsupported, single-line and oversized calls do not create drafts", () => withDirectory(async dir => {
  const h = harness(dir);
  for (const stopReason of ["aborted", "stop", "toolUse"]) await h.interrupted("write", { path: "a", content: "text\ncut" }, { stopReason });
  await h.interrupted("edit", { path: "a", content: "text\ncut" });
  await h.interrupted("bash", { command: "echo x" });
  await h.interrupted("write", { path: 2, content: "text\ncut" });
  await h.interrupted("write", { path: "a", content: "x".repeat(MAX_DRAFT_BYTES) + "\ncut" });
  assert.equal(h.latest(), undefined);
  assert.equal(h.executed.length, 0);
}));

test("import is explicit and ignores aborted trailing responses, not completed work", () => withDirectory(async dir => {
  const h = harness(dir, [
    { type: "message", message: { role: "assistant", stopReason: "error", timestamp: 1, content: [{ type: "toolCall", id: "old", name: "write", arguments: { path: "a", content: "imported\ncut" } }] } },
    { type: "message", message: { role: "assistant", stopReason: "aborted", content: [] } },
  ]);
  await h.emit("session_start");
  assert.equal(h.latest(), undefined);
  await h.command.handler("import", h.ctx);
  assert.equal(h.latest().prefix, "imported\n");
  await h.command.handler(`discard ${h.latest().id}`, h.ctx);
  await h.command.handler("import", h.ctx);
  assert.equal(h.context(), "", "explicit discard is not undone by reimport");
  h.branch.push({ type: "message", message: { role: "assistant", stopReason: "stop", content: [] } });
  await h.command.handler("import", h.ctx);
  assert.equal(h.context(), "");
}));

test("automatic continuation is bounded, waits for native settle and respects off, Esc, input and shutdown", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await withDirectory(async dir => {
  const h = harness(dir);
  h.ctx.hasUI = true;
  await h.interrupted("write", { path: "a", content: "text\ncut" });
  assert.equal(h.sent.length, 0);
  await h.emit("agent_settled", { aborted: true });
  assert.equal(h.notices.length, 0);
  for (const cancel of ["input", "session_shutdown", "off"]) {
    await h.interrupted("write", { path: "a", content: "text\ncut" });
    await h.emit("agent_settled", { aborted: false });
    if (cancel === "off") await h.command.handler("off", h.ctx);
    else await h.emit(cancel, { source: "interactive" });
  }
  assert.equal(h.sent.length, 0);
  t.mock.timers.tick(10000);
  assert.equal(h.sent.length, 0, "cancelled timers must not trigger a model call");
  await h.command.handler("on", h.ctx);
  for (const delay of [2000, 4000]) {
    await h.interrupted("write", { path: "a", content: "text\ncut" });
    await h.emit("agent_settled", { aborted: false });
    const count: number = h.sent.length;
    t.mock.timers.tick(delay - 1);
    assert.equal(h.sent.length, count);
    t.mock.timers.tick(1);
    assert.equal(h.sent.length, count + 1);
  }
  await h.interrupted("write", { path: "a", content: "text\ncut" });
  await h.emit("agent_settled", { aborted: false });
  t.mock.timers.tick(10000);
  assert.equal(h.sent.length, 2, "the extension must not make a third extra continuation");
  await h.emit("session_shutdown");
  });
});

test("context formatting never includes full large prefixes or retired drafts", () => {
  const draft: any = { id: "a", version: 1, tool: "bash", prefix: "x".repeat(20000) + "\n", status: "pending" };
  assert.ok(recoveryContext([draft]).length < 3000);
  assert.equal(recoveryContext([{ ...draft, status: "executing" }]), "");
});
