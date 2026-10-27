import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import orchestrator, { budgetNotice, registry, stallNotice } from "../extensions/orchestrator.ts";
import { SUBAGENT_CONTEXT_TYPE } from "../lib/subagent-context.ts";

/**
 * Regression cover for two defects observed in the ruumi QA orchestration run.
 *
 * 1. `session_start` restored the orchestrator registry and armed the watchdog in
 *    EVERY session. Children share the parent's session directory, so three
 *    children restored the parent's running-children list, watched their siblings,
 *    pressed Escape in their panes, and steered themselves with notices meant for
 *    the parent — which received none of the 13 notices.
 * 2. Both watchdog strings had lost their interpolations, so the parent was asked
 *    to decide with no elapsed time, no budget and no strike count.
 */

const provenance = () => ({
  version: 1,
  mode: "fork" as const,
  parentSession: "/sessions/parent.jsonl",
  parentLeafId: "asst-parent",
  parentSessionId: "parent-1",
  seededAt: "2026-10-24T15:00:00.000Z",
  seededEntries: 3,
  seededChars: 300,
  estimatedTokens: 75,
  truncated: null,
});

/** The seed marker a real Herdr fork writes; it is what makes `seeded` authoritative. */
function forkSeedBranch(): any[] {
  return [
    { type: "message", id: "user-parent", parentId: null, timestamp: "2026-10-24T14:59:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Parent asked for work" }] } },
    { type: "custom", id: "seed-marker", parentId: "user-parent", customType: SUBAGENT_CONTEXT_TYPE,
      timestamp: "2026-10-24T15:00:00.000Z", data: provenance() },
  ];
}

function fixture(opts: { tail?: string } = {}) {
  const hooks = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const notices: string[] = [];
  const sent: any[] = [];
  const paneReads: string[] = [];
  const paneGets: string[] = [];
  const interrupts: string[] = [];
  const pi: any = {
    on(name: string, fn: Function) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    appendEntry() {},
    getAllTools: () => [...tools.keys()].map(name => ({ name })),
    getActiveTools: () => [...tools.keys()],
    setActiveTools() {},
    sendMessage(message: any, options: any) { sent.push({ message, options }); },
    events: { on() {}, emit() {} },
  };
  const client: any = {
    // Existence is decided by `pane get`; `pane read` is only the diagnostic tail.
    paneGet: async (paneId: string) => { paneGets.push(paneId); return { pane_id: paneId }; },
    paneRead: async (paneId: string) => { paneReads.push(paneId); return opts.tail ?? "working"; },
    paneList: async () => [],
    paneClose: async () => {},
    paneSendKeys: async (paneId: string) => { interrupts.push(paneId); },
    paneStart: async () => ({ paneId: "pane-new" }),
  };
  orchestrator(pi, { client });
  const emit = async (name: string, event: any, ctx: any) => {
    const results: any[] = [];
    for (const hook of hooks.get(name) ?? []) results.push(await hook(event, ctx));
    return results.filter(Boolean);
  };
  return { emit, tools, notices, sent, paneReads, paneGets, interrupts };
}

function ctxFor(dir: string, params: { sessionId: string; branch?: any[]; sessionFile?: string }) {
  const sessionFile = params.sessionFile ?? join(dir, `${params.sessionId}.jsonl`);
  const notices: string[] = [];
  const ctx: any = {
    mode: "tui",
    hasUI: true,
    cwd: dir,
    isIdle: () => true,
    sessionManager: {
      getSessionDir: () => dir,
      getSessionId: () => params.sessionId,
      getSessionFile: () => sessionFile,
      getBranch: () => params.branch ?? [],
      getHeader: () => ({ id: params.sessionId }),
    },
    ui: { notify(text: string) { notices.push(text); } },
  };
  return { ctx, notices };
}

const child = (params: {
  id: string; name: string; scope: string; sessionFile: string; paneId?: string;
  startedAt?: number; budgetMs?: number; status?: string;
}) => ({
  id: params.id,
  name: params.name,
  scope: params.scope,
  sessionFile: params.sessionFile,
  paneId: params.paneId,
  status: params.status ?? "running",
  laneFiles: [],
  lastMilestoneFiles: [],
  startedAt: params.startedAt ?? Date.now(),
  budgetMs: params.budgetMs,
});

const snapshot = (children: any[]) => ({
  version: 1,
  savedAt: new Date().toISOString(),
  children,
  steers: [],
  reviews: [],
  handoffs: [],
  escalations: [],
});

test("an invalid spec-only policy fails closed: only reporting tools remain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orch-invalid-policy-"));
  const saved = {
    policy: process.env.PI_SUBAGENT_REVIEW_POLICY,
    run: process.env.PI_SUBAGENT_REVIEW_RUN,
    lens: process.env.PI_SUBAGENT_REVIEW_LENS,
    target: process.env.PI_SUBAGENT_REVIEW_TARGET,
    dir: process.env.PI_SUBAGENT_REVIEW_DIR,
  };
  process.env.PI_SUBAGENT_REVIEW_POLICY = "spec-only";
  // Deliberately incomplete: no run, lens, target or report dir.
  for (const key of ["PI_SUBAGENT_REVIEW_RUN", "PI_SUBAGENT_REVIEW_LENS", "PI_SUBAGENT_REVIEW_TARGET", "PI_SUBAGENT_REVIEW_DIR"]) {
    delete process.env[key];
  }
  try {
    const f = fixture();
    const { ctx } = ctxFor(dir, { sessionId: "reviewer-9", branch: forkSeedBranch() });

    const blocked = await f.emit("tool_call", { toolName: "read" }, ctx);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].block, true);
    assert.match(blocked[0].reason, /cannot be read in full/);

    // Reporting is the only remaining path: a reviewer with a broken policy must
    // be able to say so, not silently continue as an ordinary child.
    assert.deepEqual(await f.emit("tool_call", { toolName: "orch_done" }, ctx), []);
    assert.deepEqual(await f.emit("tool_call", { toolName: "orch_ping" }, ctx), []);
  } finally {
    for (const [key, value] of Object.entries({
      PI_SUBAGENT_REVIEW_POLICY: saved.policy,
      PI_SUBAGENT_REVIEW_RUN: saved.run,
      PI_SUBAGENT_REVIEW_LENS: saved.lens,
      PI_SUBAGENT_REVIEW_TARGET: saved.target,
      PI_SUBAGENT_REVIEW_DIR: saved.dir,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("a delegated child never restores, watches, or writes the orchestrator registry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orch-child-guard-"));
  try {
    // A sidecar the parent wrote before the child started.
    await writeFile(join(dir, "orchestrator-registry-parent-1.json"), JSON.stringify(snapshot([
      child({ id: "sib", name: "sibling", scope: "sibling-only", sessionFile: join(dir, "sib.jsonl"), paneId: "pane-sib" }),
    ])));

    const f = fixture();
    const { ctx, notices } = ctxFor(dir, { sessionId: "child-9", branch: forkSeedBranch() });

    await f.emit("session_start", { type: "session_start" }, ctx);

    assert.equal(registry.getChildrenInScope("sibling-only").length, 0,
      "a child must not adopt the parent's running children");
    assert.equal(f.paneGets.length, 0, "a child must not probe sibling panes at startup");
    assert.equal(f.paneReads.length, 0, "a child must not read sibling panes at startup");
    assert.ok(!notices.some(text => text.includes("orchestrator active")),
      "a child must not be told it is the orchestrator");

    // The orchestrator surface is parent-only: refuse it rather than spawn work the
    // parent cannot see, review, or stop.
    const blocked = await f.emit("tool_call", { toolName: "orch_spawn" }, ctx);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].block, true);
    assert.match(blocked[0].reason, /parent-only/);
    const retired = await f.emit("tool_call", { toolName: "subagent" }, ctx);
    assert.equal(retired.length, 1);
    assert.equal(retired[0].block, true);
    assert.match(retired[0].reason, /removed/);
    assert.deepEqual(await f.emit("tool_call", { toolName: "orch_done" }, ctx), [],
      "a child owns its completion tool");
    assert.deepEqual(await f.emit("tool_call", { toolName: "read" }, ctx), [],
      "ordinary tools stay untouched in a child");

    // Shutdown must not create a sidecar for the child, and must not touch the parent's.
    const before = JSON.parse(await readFile(join(dir, "orchestrator-registry-parent-1.json"), "utf8"));
    await f.emit("session_shutdown", {}, ctx);
    const files = await readdir(dir);
    assert.ok(!files.includes("orchestrator-registry-child-9.json"),
      `child wrote its own sidecar: ${files.join(", ")}`);
    const after = JSON.parse(await readFile(join(dir, "orchestrator-registry-parent-1.json"), "utf8"));
    assert.deepEqual(after, before, "a child must never rewrite the parent's sidecar");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only the owning session restores and writes its own registry sidecar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orch-owner-registry-"));
  try {
    // Legacy, unkeyed file. It is shared by every session in this cwd, which is
    // exactly why it must not be adopted.
    await writeFile(join(dir, "orchestrator-registry.json"), JSON.stringify(snapshot([
      child({ id: "legacy", name: "legacy", scope: "legacy-only", sessionFile: join(dir, "legacy.jsonl"), paneId: "pane-legacy" }),
    ])));
    // This session's own keyed file.
    await writeFile(join(dir, "orchestrator-registry-parent-2.json"), JSON.stringify(snapshot([
      child({ id: "own", name: "owner-child", scope: "owner-only", sessionFile: join(dir, "own.jsonl"), paneId: "pane-own" }),
    ])));

    const f = fixture();
    const { ctx, notices } = ctxFor(dir, { sessionId: "parent-2", branch: [] });
    await f.emit("session_start", { type: "session_start" }, ctx);

    assert.equal(registry.getChildrenInScope("owner-only").length, 1, "own sidecar restores");
    assert.equal(registry.getChildrenInScope("legacy-only").length, 0,
      "another session's unkeyed sidecar is not adopted");
    assert.ok(notices.some(text => text.includes("orchestrator active")));
    assert.deepEqual(f.paneGets, ["pane-own"], "reconciliation only touches its own children");
    assert.deepEqual(f.paneReads, ["pane-own"], "reconciliation only touches its own children");

    await f.emit("session_shutdown", {}, ctx);
    assert.ok((await readdir(dir)).includes("orchestrator-registry-parent-2.json"));

    const legacy = JSON.parse(await readFile(join(dir, "orchestrator-registry.json"), "utf8"));
    assert.deepEqual(legacy.children.map((entry: any) => entry.scope), ["legacy-only"],
      "the owner never writes the shared, unkeyed sidecar");
    const own = JSON.parse(await readFile(join(dir, "orchestrator-registry-parent-2.json"), "utf8"));
    assert.equal(own.children.filter((entry: any) => entry.scope === "owner-only").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a new session in the same process does not inherit the replaced session's children", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orch-session-switch-"));
  try {
    await writeFile(join(dir, "orchestrator-registry-session-a.json"), JSON.stringify(snapshot([
      child({
        id: "old-a", name: "old-child", scope: "old-scope",
        sessionFile: join(dir, "old.jsonl"), paneId: "pane-old", status: "completed",
      }),
    ])));

    const f = fixture();
    const ctxA = ctxFor(dir, { sessionId: "session-a", branch: [] }).ctx;
    await f.emit("session_start", { type: "session_start" }, ctxA);
    assert.equal(registry.getChildrenInScope("old-scope").length, 1, "session A restores its own child");
    await f.emit("session_shutdown", { type: "session_shutdown", reason: "new" }, ctxA);

    // Pi replaces the session *inside* the same process (`/new`), so the next
    // session_start sees a new id on the same extension instance and no sidecar
    // of its own. The replaced session's rows must not follow it.
    const ctxB = ctxFor(dir, { sessionId: "session-b", branch: [] }).ctx;
    await f.emit("session_start", { type: "session_start", reason: "new" }, ctxB);
    assert.equal(registry.getChildrenInScope("old-scope").length, 0,
      "the new session inherited the replaced session's child");

    await f.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctxB);
    const own = JSON.parse(await readFile(join(dir, "orchestrator-registry-session-b.json"), "utf8"));
    assert.deepEqual(own.children, [], "the new session's sidecar contains only its own work");
  } finally {
    registry.resetForTests();
    await rm(dir, { recursive: true, force: true });
  }
});

test("watchdog notices carry the facts that justify the interrupt", () => {
  const budget = budgetNotice({ name: "guards-core", scope: "guards-core", elapsedMs: 42 * 60_000, budgetMs: 30 * 60_000 });
  assert.match(budget, /42m elapsed of 30m/);
  assert.match(budget, /orch_resume/);
  assert.doesNotMatch(budget, /budget Decide/);

  const stall = stallNotice({ name: "guards-core", scope: "guards-core", strikes: 3, intervalMs: 30_000 });
  assert.match(stall, /3 consecutive checks \(~2m\)/);
  assert.match(stall, /Inspect its pane/);
  assert.doesNotMatch(stall, /progress for It/);
});

test("a research or QA child's shell is read-only even when the pane holds bash", async () => {
  const previous = process.env.PI_SUBAGENT_PURPOSE;
  try {
    const f = fixture();
    const ctx: any = {
      cwd: process.cwd(),
      sessionManager: {
        getSessionDir: () => "/tmp",
        getSessionId: () => "reading-child",
        getBranch: () => [],
        getSessionFile: () => "/tmp/reading-child.jsonl",
        getHeader: () => undefined,
      },
      ui: { notify() {} },
    };

    // The role travels in the launcher-written environment, so a resumed or
    // user-touched pane cannot widen itself back into a writer.
    process.env.PI_SUBAGENT_PURPOSE = "research";
    const writeEvent = { toolName: "bash", input: { command: "echo x > f" } };
    const [writeResult] = await f.emit("tool_call", writeEvent, ctx);
    assert.ok(writeResult?.block, "a research child cannot write through bash");
    assert.match(writeResult.reason, /Research child: bash is read-only/);

    const readEvent = { toolName: "bash", input: { command: "git status" } };
    const [readResult] = await f.emit("tool_call", readEvent, ctx);
    assert.equal(readResult, undefined, "read-only inspection is still allowed");
    assert.match(readEvent.input.command, /status/, "the grammar re-quotes the command");

    process.env.PI_SUBAGENT_PURPOSE = "review";
    const qaWrite = { toolName: "bash", input: { command: "tee f" } };
    const [qaResult] = await f.emit("tool_call", qaWrite, ctx);
    assert.ok(qaResult?.block, "a QA child cannot write through bash");
    assert.match(qaResult.reason, /QA child: bash is read-only/);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_PURPOSE;
    else process.env.PI_SUBAGENT_PURPOSE = previous;
  }
});
