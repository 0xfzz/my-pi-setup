import test from "node:test";
import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdtemp, rm, writeFile, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import checkpoints, { readMilestone, writeMilestone, transcriptPreview } from "../extensions/subagent-checkpoints.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  CHECKPOINT_TYPE, CONTEXT_TYPE, PROGRESS_SUFFIX, launched, outcome, applyMilestone,
  recordsFromBranch, checkpointContext, milestoneOf, subagentStatusIcon,
} from "../lib/subagent-state.ts";
import { herdrRoot } from "./fixtures/herdr-root.ts";

const time = "2026-10-18T10:00:00.000Z";
function launch(sessionFile = "/tmp/child.jsonl", runId = "run1") {
  return launched({ status: "started", id: runId, name: "Scout", sessionFile, task: "Inspect auth" }, {}, undefined, time)!;
}
function progress(sessionFile = "/tmp/child.jsonl", runId = "run1") {
  return milestoneOf({ version: 1, runId, sessionFile, updatedAt: "2026-10-18T10:01:00.000Z", summary: "Found validation bug", files: ["src/auth.ts"], verification: "3 tests pass", next: "Fix auth", blocked: false })!;
}
function harness() {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const entries: any[] = [];
  const notifications: any[] = [];
  const sent: any[] = [];
  const widgets = new Map<string, any>();
  const pi: any = {
    on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand(name: string, command: any) { commands.set(name, command); },
    appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data, timestamp: new Date().toISOString() }); },
    sendUserMessage(text: string) { sent.push(text); },
  };
  const context: any = {
    hasUI: true, sessionManager: { getBranch: () => entries },
    ui: { setWidget(name: string, data: any) { widgets.set(name, data); }, notify(...args: any[]) { notifications.push(args); } },
  };
  checkpoints(pi);
  async function emit(name: string, event: any = {}) {
    let result: any;
    for (const fn of handlers.get(name) ?? []) result = await fn(event, context) ?? result;
    return result;
  }
  return { pi, context, emit, tools, commands, entries, widgets, notifications, sent };
}

test("launch, branch replay, custom results, interrupted exits and questions are durable", () => {
  const a = launch();
  const entries: any[] = [{ type: "custom", customType: CHECKPOINT_TYPE, data: a }];
  const msg = { role: "toolResult", toolName: "agent_spawn", details: { id: "run1", status: "started", sessionFile: a.sessionFile, name: "Scout" } };
  entries.push({ type: "message", message: msg, timestamp: time });
  assert.equal(recordsFromBranch(entries).get(a.sessionFile)?.task, "Inspect auth");
  entries.push({ type: "custom_message", customType: "subagent_result", details: { sessionFile: a.sessionFile, name: "Scout", disposition: "completed", summary: "Fixed it" }, content: "result", timestamp: time });
  assert.equal(recordsFromBranch(entries).get(a.sessionFile)?.status, "completed");
  assert.equal(recordsFromBranch(entries).get(a.sessionFile)?.ended, true);
  assert.equal(recordsFromBranch(entries.slice(0, 2)).get(a.sessionFile)?.status, "running", "other tree branch excludes the result");
  assert.equal(outcome({ customType: "subagent_result", details: { sessionFile: a.sessionFile, disposition: "completed-user-exit" } }, a)?.status, "closed");
  assert.equal(outcome({ customType: "subagent_result", details: { sessionFile: a.sessionFile, disposition: "pane-killed" } }, a)?.status, "failed");
  const ping = outcome({ customType: "subagent_ping", details: { sessionFile: a.sessionFile, message: "Which schema?" } }, a)!;
  assert.equal(ping.status, "blocked"); assert.equal(ping.ended, true);
});

test("milestones deduplicate, reject previous runs, and never overwrite terminal outcomes", () => {
  const record = launch();
  const milestone = progress();
  const next = applyMilestone(record, milestone);
  assert.equal(next.summary, "Found validation bug");
  assert.deepEqual(next.files, ["src/auth.ts"]);
  assert.equal(applyMilestone(next, milestone), next);
  assert.equal(applyMilestone(record, progress(record.sessionFile, "old-run")), record);
  const finished = outcome({ customType: "subagent_result", details: { sessionFile: record.sessionFile, disposition: "completed" } }, next)!;
  assert.equal(applyMilestone(finished, milestone), finished);
  const liveBlocked = applyMilestone(record, { ...milestone, blocked: true });
  assert.equal(liveBlocked.status, "blocked"); assert.equal(liveBlocked.ended, false, "milestone does not authorize a concurrent resume");
  const resumed = launched({ id: "run2", status: "started", sessionPath: record.sessionFile, name: "Again" }, { message: "Try another fix" }, finished, time)!;
  assert.equal(resumed.ended, false); assert.equal(resumed.task, "Try another fix");
  assert.equal(applyMilestone(resumed, milestone), resumed);
});

test("late outcomes cannot end a resumed pane or admit an off-branch child", async () => {
  const old = { ...launch(), paneId: "old-pane" };
  const resumed = launched({ id: "run2", status: "started", sessionPath: old.sessionFile, paneId: "new-pane", name: "Scout" }, {}, old, time)!;
  const stale = { customType: "subagent_result", content: "Old result", details: { sessionFile: old.sessionFile, paneId: "old-pane", disposition: "completed", summary: "Old done" } };
  assert.equal(outcome(stale, resumed), undefined);
  assert.equal(outcome(stale), undefined, "result delivery alone is not registry admission");
  assert.equal(outcome({ ...stale, details: { ...stale.details, paneId: "new-pane" } }, resumed)?.status, "completed");
  const entries: any[] = [{ type: "custom", customType: CHECKPOINT_TYPE, data: resumed }, { type: "custom_message", ...stale, timestamp: time }];
  assert.equal(recordsFromBranch(entries).get(old.sessionFile)?.runId, "run2");
  assert.equal(recordsFromBranch(entries).get(old.sessionFile)?.ended, false);
  assert.equal(recordsFromBranch(entries.slice(1)).size, 0);
  const h = harness();
  try {
    await h.emit("session_start");
    await h.emit("message_end", { message: { role: "custom", ...stale } });
    assert.equal(h.entries.length, 0);
  } finally { await h.emit("session_shutdown"); }
});

test("a valid same-run milestone may precede the launch acknowledgement", () => {
  const record = { ...launch(), updatedAt: "2026-10-18T10:05:00.000Z" };
  const early = progress();
  const accepted = applyMilestone(record, early);
  assert.equal(accepted.summary, "Found validation bug");
  assert.equal(accepted.milestoneAt, early.updatedAt);
  assert.equal(applyMilestone(accepted, { ...early, updatedAt: time, summary: "Stale milestone" }), accepted);
});

test("context is bounded, prioritizes active work and honestly labels recovered liveness", () => {
  const records = new Map();
  for (let i = 0; i < 80; i++) {
    const r = { ...launch(`/tmp/${i}.jsonl`), status: "completed" as const, ended: true, summary: "z".repeat(6000), task: "t".repeat(2000), files: Array(20).fill("f".repeat(300)) };
    records.set(r.sessionFile, r);
  }
  records.set("/tmp/active.jsonl", launch("/tmp/active.jsonl"));
  const text = checkpointContext(records, new Set(), 6000);
  assert.ok(text.length <= 6000);
  assert.ok(text.includes("unverified (last known running"));
  assert.ok(text.includes("older/additional children omitted"));
  assert.ok(text.indexOf("/tmp/active.jsonl") < text.indexOf("/tmp/0.jsonl"));
});

test("a spec-only reviewer's context is not polluted with checkpoint state", async () => {
  const previous = process.env.PI_SUBAGENT_REVIEW_POLICY;
  process.env.PI_SUBAGENT_REVIEW_POLICY = "spec-only";
  const h = harness();
  try {
    h.entries.push({ type: "custom", customType: CHECKPOINT_TYPE, data: launch("/tmp/reviewer.jsonl") });
    await h.emit("session_start");
    const messages = [{ role: "user", content: "pinned ticket" }];
    const out = await h.emit("context", { messages });
    assert.deepEqual(out.messages, messages, "a reviewer sees only its ticket");
    assert.equal(out.messages.some((m: any) => m.customType === CONTEXT_TYPE), false);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_REVIEW_POLICY;
    else process.env.PI_SUBAGENT_REVIEW_POLICY = previous;
    await h.emit("session_shutdown");
  }
});

test("atomic progress sidecars validate, cap sizes and use private permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-progress-test-"));
  try {
    const path = join(dir, "child.jsonl");
    await writeMilestone(progress(path));
    assert.equal((await readMilestone(path))?.summary, "Found validation bug");
    assert.equal((await stat(path + PROGRESS_SUFFIX)).mode & 0o777, 0o600);
    await writeFile(path + PROGRESS_SUFFIX, "not JSON"); assert.equal(await readMilestone(path), undefined);
    await writeFile(path + PROGRESS_SUFFIX, "x".repeat(33000)); assert.equal(await readMilestone(path), undefined);
    assert.equal(milestoneOf({ version: 1 }), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("runtime handlers inject checkpoints after compaction without duplicates; restore and branch switch are scoped", async () => {
  const h = harness();
  try {
    await h.emit("session_start");
    await h.emit("tool_execution_start", { toolName: "agent_spawn", toolCallId: "a", args: { task: "Inspect auth" } });
    await h.emit("tool_execution_end", { toolName: "agent_spawn", toolCallId: "a", result: { details: { status: "started", id: "run1", name: "Scout", sessionFile: "/missing/child.jsonl" } } });
    assert.equal(h.entries.length, 1);
    assert.equal(h.entries[0].data.task, "Inspect auth");
    const compacted: any[] = [{ role: "user", content: "Compacted summary with no child detail", timestamp: 1 }];
    const first = await h.emit("context", { messages: compacted });
    assert.equal(first.messages.filter((m: any) => m.customType === CONTEXT_TYPE).length, 1);
    assert.ok(first.messages.at(-1).content.includes("Inspect auth"));
    assert.ok(!first.messages.at(-1).content.includes("unverified"), "launch observed in runtime");
    const second = await h.emit("context", { messages: first.messages });
    assert.equal(second.messages.filter((m: any) => m.customType === CONTEXT_TYPE).length, 1);
    await h.emit("session_start", { reason: "reload" });
    const recovered = await h.emit("context", { messages: compacted });
    assert.ok(recovered.messages.at(-1).content.includes("unverified"));
    h.entries.length = 0;
    await h.emit("session_tree");
    assert.equal((await h.emit("context", { messages: compacted })).messages.length, 1);
    const tool = h.tools.get("agent_history");
    await assert.rejects(() => tool.execute("x", { sessionPath: "/arbitrary/private/file" }, undefined, undefined, h.context), /not recorded/);
  } finally { await h.emit("session_shutdown"); }
});

test("parent ingests child milestone on next context and persists it for reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-progress-parent-"));
  const h = harness();
  const file = join(dir, "child.jsonl");
  try {
    h.entries.push({ type: "custom", customType: CHECKPOINT_TYPE, data: launch(file) });
    await writeMilestone(progress(file));
    await h.emit("session_start");
    const event = await h.emit("context", { messages: [] });
    assert.ok(event.messages.at(-1).content.includes("Found validation bug"));
    assert.ok(h.entries.some(e => e.data?.summary === "Found validation bug"));
    assert.equal(h.notifications.length, 1);
    await h.emit("context", { messages: [] });
    assert.equal(h.notifications.length, 1, "same milestone is not appended or notified twice");
    await h.emit("session_shutdown");
    await rm(file + PROGRESS_SUFFIX);
    await h.emit("session_start");
    assert.ok((await h.emit("context", { messages: [] })).messages.at(-1).content.includes("Found validation bug"));
  } finally { await h.emit("session_shutdown"); await rm(dir, { recursive: true, force: true }); }
});

test("dashboard previews are read-only and an active milestone cannot trigger resume", async () => {
  const h = harness();
  try {
    h.entries.push({ type: "custom", customType: CHECKPOINT_TYPE, data: { ...launch(), status: "blocked", ended: false, next: "Need a file" } });
    await h.emit("session_start");
    let selects = 0;
    const editorCalls: any[] = [];
    h.context.ui.select = async (_title: string, options: string[]) => {
      selects++;
      if (selects === 1) return options[0];
      assert.ok(!options.includes("Request resume in a new Herdr pane"));
      return options[0];
    };
    h.context.ui.editor = async (...args: any[]) => { editorCalls.push(args); return "ignored changes"; };
    await h.commands.get("subagents").handler("", h.context);
    assert.equal(editorCalls.length, 1); assert.equal(h.sent.length, 0);
    assert.equal(h.entries[0].data.summary, "");
  } finally { await h.emit("session_shutdown"); }
});

test("dashboard resumes require an explicit answer and revalidate the ended run", async () => {
  const h = harness();
  const ended = outcome({ customType: "subagent_result", details: { sessionFile: "/tmp/child.jsonl", disposition: "completed" } }, launch())!;
  h.entries.push({ type: "custom", customType: CHECKPOINT_TYPE, data: ended });
  let answer: string | undefined;
  try {
    await h.emit("session_start");
    h.context.ui.select = async (_title: string, options: string[]) => options.find(o => o === "Request resume in a new Herdr pane") ?? options[0];
    h.context.ui.input = async () => answer;
    await h.commands.get("subagents").handler("", h.context);
    assert.equal(h.sent.length, 0, "dismissal is not permission to resume");
    answer = "Add one regression test";
    await h.commands.get("subagents").handler("", h.context);
    assert.equal(h.sent.length, 1);
    assert.ok(h.sent[0].includes("Add one regression test"));
    h.context.ui.input = async () => {
      h.entries.push({ type: "custom", customType: CHECKPOINT_TYPE, data: launch(ended.sessionFile, "new-run") });
      return "More work";
    };
    await h.commands.get("subagents").handler("", h.context);
    assert.equal(h.sent.length, 1, "a concurrently resumed writer invalidates the old dialog");
  } finally { await h.emit("session_shutdown"); }
});

test("idle parent receives milestone filesystem events without model wakeups", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-progress-watch-"));
  try {
    const probe = watch(dir, () => {});
    probe.close();
  } catch (err: any) {
    if (err?.code === "ENOSPC") {
      t.skip("System inotify watch limit reached (ENOSPC)");
      await rm(dir, { recursive: true, force: true });
      return;
    }
  }
  const h = harness();
  const file = join(dir, "child.jsonl");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    h.entries.push({ type: "custom", customType: CHECKPOINT_TYPE, data: launch(file) });
    await h.emit("session_start");
    const notified = new Promise<void>((resolve, reject) => {
      h.context.ui.notify = () => resolve();
      timer = setTimeout(() => reject(new Error("Milestone filesystem event was not delivered")), 3000);
    });
    await writeMilestone(progress(file));
    await notified;
    assert.equal(h.entries.at(-1).data.summary, "Found validation bug");
    assert.equal(h.sent.length, 0);
  } finally { clearTimeout(timer); await h.emit("session_shutdown"); await rm(dir, { recursive: true, force: true }); }
});

test("child publishes explicit and todo milestones; restricted Herdr profiles retain the progress tool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-progress-child-"));
  const file = join(dir, "child.jsonl");
  const oldSession = process.env.PI_SUBAGENT_SESSION;
  const oldRun = process.env.PI_SUBAGENT_ID;
  const oldArgv = process.argv;
  let h: ReturnType<typeof harness> | undefined;
  try {
    process.env.PI_SUBAGENT_SESSION = file; process.env.PI_SUBAGENT_ID = "run1";
    // Herdr launches a child with `--session <its own file>`; that argument is
    // what proves the inherited env belongs to this process.
    process.argv = [...process.argv, "--session", file];
    h = harness();
    const tool = h.tools.get("agent_progress");
    assert.ok(tool);
    await tool.execute("m1", { summary: "Implemented input validation", files: ["src/auth.ts"], verification: "3 tests pass", next: "Review" });
    assert.equal((await readMilestone(file))?.verification, "3 tests pass");
    await h.emit("tool_execution_end", { toolName: "workflow_todo", result: { details: { items: [{ text: "Review changes", status: "in_progress" }] } } });
    const data = await readMilestone(file);
    assert.ok(data?.summary.includes("Review changes"));
    assert.equal(data?.verification, "3 tests pass");
    const root = herdrRoot();
    if (!root) throw new Error("Could not find the vendored pi-herdr-subagents source");
    const { buildSubagentToolAllowlist } = await import(root + "/src/launch.ts");
    const allow = buildSubagentToolAllowlist("read,bash")!.split(",");
    assert.ok(allow.includes("agent_progress"));
    assert.ok(allow.includes("workflow_todo"), "restricted children can settle a v1 transcript");
    for (const tool of ["todo_plan", "todo_act", "todo_next"]) {
      assert.ok(allow.includes(tool), `restricted children keep the v2 todo surface (${tool})`);
    }
    assert.equal(buildSubagentToolAllowlist(undefined), null);
  } finally {
    if (oldSession === undefined) delete process.env.PI_SUBAGENT_SESSION; else process.env.PI_SUBAGENT_SESSION = oldSession;
    if (oldRun === undefined) delete process.env.PI_SUBAGENT_ID; else process.env.PI_SUBAGENT_ID = oldRun;
    process.argv = oldArgv;
    await h?.emit("session_shutdown"); await rm(dir, { recursive: true, force: true });
  }
});

test("saved child transcript preview reads its active branch without exposing thinking", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-child-preview-"));
  try {
    const empty = join(dir, "empty.jsonl");
    await writeFile(empty, "");
    assert.throws(() => transcriptPreview(empty), /no valid session header/);
    assert.equal(await readFile(empty, "utf8"), "", "preview must never initialize an empty child file");
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: "Review this", timestamp: Date.now() });
    const root = manager.getLeafId()!;
    const assistant: any = { role: "assistant", api: "test", provider: "test", model: "test", timestamp: Date.now(), content: [{ type: "thinking", thinking: "PRIVATE THOUGHT" }, { type: "text", text: "Abandoned branch" }], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    manager.appendMessage(assistant);
    manager.branch(root);
    manager.appendMessage({ ...assistant, content: [{ type: "text", text: "Current child progress" }] });
    const text = transcriptPreview(manager.getSessionFile()!);
    assert.ok(text.includes("Current child progress"));
    assert.ok(!text.includes("Abandoned branch")); assert.ok(!text.includes("PRIVATE THOUGHT"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("subagentStatusIcon provides distinct single-column glyphs without emojis", () => {
  const statuses = ["running", "completed", "blocked", "failed", "closed"] as const;
  const icons = statuses.map(s => subagentStatusIcon(s));
  assert.equal(new Set(icons).size, statuses.length, "all icons must be distinct");
  assert.equal(subagentStatusIcon("running", true), "◇");
  for (const icon of [...icons, "◇"]) {
    assert.ok(!/\p{Extended_Pictographic}/u.test(icon), `icon ${icon} must not be an emoji`);
    assert.equal(icon.length, 1, `icon ${icon} must be a single code point`);
  }
});

test("browseSubagents renders framed PopupPanel menus and scrollable text detail when ui.custom is available", async () => {
  const h = harness();
  const file = "/tmp/child-custom.jsonl";
  h.entries.push({ type: "custom", customType: CHECKPOINT_TYPE, data: launch(file) });
  await h.emit("session_start");

  const customCalls: any[] = [];
  h.context.ui.custom = (factory: any, options: any) => {
    return new Promise((resolve) => {
      let component: any;
      const tui = { requestRender: () => {} };
      const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
      component = factory(tui, theme, {}, (val: any) => resolve(val));
      customCalls.push({ factory, options, component, resolve });
    });
  };

  const waitFor = async (fn: () => boolean, timeout = 2000) => {
    const start = Date.now();
    while (!fn() && Date.now() - start < timeout) await new Promise((r) => setTimeout(r, 5));
  };

  const browsePromise = h.commands.get("subagents").handler("", h.context);
  await waitFor(() => customCalls.length >= 1);

  // First custom call: subagents list picker
  assert.equal(customCalls.length, 1);
  const listPicker = customCalls[0];
  assert.equal(listPicker.options.overlay, true);
  const listRender = listPicker.component.render(60);
  assert.ok(listRender.some((l: string) => l.includes("╭") && l.includes("╮")), "List picker must be framed");
  assert.match(listRender.join("\n"), /Subagents/);
  assert.match(listRender.join("\n"), /Scout/);
  assert.ok(listRender.every((l: string) => visibleWidth(l) <= 60));
  assert.ok(listPicker.component.render(8).every((l: string) => visibleWidth(l) <= 8));

  // Select first subagent with Enter
  listPicker.component.handleInput("enter");
  await waitFor(() => customCalls.length >= 2);

  // Second custom call: actions menu picker
  assert.equal(customCalls.length, 2);
  const actionPicker = customCalls[1];
  assert.equal(actionPicker.options.overlay, true);
  const actionRender = actionPicker.component.render(60);
  assert.ok(actionRender.some((l: string) => l.includes("╭") && l.includes("╮")), "Action picker must be framed");
  assert.match(actionRender.join("\n"), /View saved checkpoint \/ result/);
  assert.ok(actionRender.every((l: string) => visibleWidth(l) <= 60));

  // Select "View saved checkpoint / result" with Enter
  actionPicker.component.handleInput("enter");
  await waitFor(() => customCalls.length >= 3);

  // Third custom call: text detail popup (checkpoint describe)
  assert.equal(customCalls.length, 3);
  const textDetail = customCalls[2];
  assert.equal(textDetail.options.overlay, true);
  const detailRender = textDetail.component.render(60);
  assert.ok(detailRender.some((l: string) => l.includes("╭") && l.includes("╮")), "Text detail must be framed");
  assert.match(detailRender.join("\n"), /Saved checkpoint/);
  assert.match(detailRender.join("\n"), /Inspect auth/);
  assert.ok(detailRender.every((l: string) => visibleWidth(l) <= 60));

  // Esc closes text detail
  textDetail.component.handleInput("escape");
  await browsePromise;
  await h.emit("session_shutdown");
});
