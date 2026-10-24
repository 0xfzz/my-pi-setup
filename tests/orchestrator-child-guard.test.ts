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
    paneRead: async (paneId: string) => { paneReads.push(paneId); return opts.tail ?? "working"; },
    paneSendKeys: async (paneId: string) => { interrupts.push(paneId); },
    paneStart: async () => ({ paneId: "pane-new" }),
  };
  orchestrator(pi, { client });
  const emit = async (name: string, event: any, ctx: any) => {
    const results: any[] = [];
    for (const hook of hooks.get(name) ?? []) results.push(await hook(event, ctx));
    return results.filter(Boolean);
  };
  return { emit, tools, notices, sent, paneReads, interrupts };
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
    assert.equal(f.paneReads.length, 0, "a child must not read sibling panes at startup");
    assert.ok(!notices.some(text => text.includes("orchestrator active")),
      "a child must not be told it is the orchestrator");

    // The orchestrator surface is parent-only: refuse it rather than spawn work the
    // parent cannot see, review, or stop.
    const blocked = await f.emit("tool_call", { toolName: "orch_spawn" }, ctx);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].block, true);
    assert.match(blocked[0].reason, /parent-only/);
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
