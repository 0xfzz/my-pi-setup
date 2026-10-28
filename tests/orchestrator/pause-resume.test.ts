import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import agentExtension, { registry } from "../../extensions/agent.ts";
import type { ScopedChild } from "../../lib/orchestrator/scope-registry.ts";

type ModeId = null;

interface Harness {
  tools: Map<string, any>;
  commands: Map<string, any>;
  notices: Array<{ text: string; level: string }>;
  calls: { keys: Array<{ paneId: string; keys: string[] }>; close: string[]; start: any[] };
  ctx: any;
  emit: (name: string, event: any) => Promise<any[]>;
}

function branch(_modeId: ModeId) {
  return [];
}

function harness(options: {
  dir: string;
  modeId?: ModeId;
  paneClose?: (paneId: string) => Promise<void>;
  paneGet?: (paneId: string) => Promise<{ pane_id?: string } | null>;
}): Harness {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const hooks = new Map<string, Function[]>();
  const notices: Harness["notices"] = [];
  const calls: Harness["calls"] = { keys: [], close: [], start: [] };

  const client: any = {
    paneGet: options.paneGet ?? (async (paneId: string) => ({ pane_id: paneId })),
    paneRead: async () => "user@box:~$ ",
    paneList: async () => [],
    paneSendKeys: async (paneId: string, keys: string[]) => {
      calls.keys.push({ paneId, keys });
    },
    paneClose:
      options.paneClose ??
      (async (paneId: string) => {
        calls.close.push(paneId);
      }),
    paneStart: async (plan: any) => {
      calls.start.push(plan);
      return { paneId: `w9:p${calls.start.length}` };
    },
  };

  const ctx: any = {
    cwd: options.dir,
    ui: { notify: (text: string, level: "info" | "warning" | "error") => notices.push({ text, level }) },
    sessionManager: {
      getBranch: () => branch(options.modeId ?? null),
      getSessionDir: () => options.dir,
      getSessionId: () => "parent-pause",
      getSessionFile: () => join(options.dir, "parent.jsonl"),
    },
  };

  const pi: any = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, config: any) {
      commands.set(name, config);
    },
    on(name: string, fn: Function) {
      hooks.set(name, [...(hooks.get(name) ?? []), fn]);
    },
    sendMessage() {},
    appendEntry() {},
    getAllTools() {
      return [...tools.values()];
    },
  };

  agentExtension(pi, {
    client,
    stream: { watch: () => () => {}, onReconcile: () => () => {} },
    now: () => 10_000_000,
    watchdogIntervalMs: 30_000,
  });

  const emit = async (name: string, event: any) => {
    const results: any[] = [];
    for (const fn of hooks.get(name) ?? []) results.push(await fn(event, ctx));
    return results.filter(Boolean);
  };

  return { tools, commands, notices, calls, ctx, emit };
}

let seq = 0;

function child(partial: Partial<ScopedChild> = {}): ScopedChild {
  const id = partial.id ?? `pause-${++seq}`;
  return {
    id,
    name: `Worker ${id}`,
    scope: `scope-${id}`,
    sessionFile: partial.sessionFile ?? `/tmp/orchestrator-tests/${id}.jsonl`,
    paneId: `w1:p${++seq}`,
    status: "running",
    laneFiles: ["src/x/"],
    lastMilestoneFiles: [],
    task: `finish ${id}`,
    updatedAt: new Date(0).toISOString(),
    startedAt: 0,
    budgetMs: 30 * 60_000,
    watchdog: { trip: null, interrupts: 0 },
    ...partial,
  } as ScopedChild;
}

async function pause(h: Harness) {
  await h.commands.get("agent-pause").handler("", h.ctx);
}

async function resume(h: Harness) {
  await h.commands.get("agent-resume").handler("", h.ctx);
}

describe("/agent-pause closes the run but keeps it resumable", () => {
  beforeEach(() => registry.resetForTests());

  it("closes every active child, marks it paused, and refuses new spawns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-pause-"));
    const h = harness({ dir });
    const running = child({ id: "p-running", status: "running" });
    const blocked = child({ id: "p-blocked", status: "blocked" });
    registry.registerChild(running);
    registry.registerChild(blocked);

    try {
      await pause(h);

      assert.deepEqual(h.calls.keys.map((c) => c.paneId).sort(), [running.paneId, blocked.paneId].sort());
      assert.deepEqual(h.calls.close.sort(), [running.paneId, blocked.paneId].sort());
      for (const target of [running, blocked]) {
        const row = registry.getChildById(target.id)!;
        assert.equal(row.status, "closed");
        assert.equal(row.closeReason, "paused", "the pause reason is what resume replays");
      }
      assert.equal(registry.isPaused(), true);
      assert.equal(h.notices.at(-1)!.level, "info");

      const spawned = await h.tools.get("agent_spawn").execute("t", {
        name: "nope",
        task: "should not start",
        handoffId: "missing-but-irrelevant",
      });
      assert.equal((spawned.details as any).error, "orchestrator-paused");
      assert.equal(h.calls.start.length, 0, "a paused orchestrator starts nothing");
    } finally {
      await h.emit("session_shutdown", {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a failed close instead of calling the child paused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-pause-"));
    const stubborn = child({ id: "p-stubborn", status: "running" });
    const h = harness({
      dir,
      paneClose: async (paneId: string) => {
        if (paneId === stubborn.paneId) throw new Error("permission denied");
        h.calls.close.push(paneId);
      },
    });
    registry.registerChild(stubborn);

    try {
      await pause(h);

      const row = registry.getChildById(stubborn.id)!;
      assert.equal(row.status, "running", "a live pane must stay under the watchdog");
      assert.equal(row.closeReason, undefined, "it was not closed, so it is not paused");
      assert.equal(row.watchdog?.trip, "close-failed");
      assert.match(h.notices.at(-1)!.text, /Still live/);
      assert.equal(h.notices.at(-1)!.level, "warning");
      assert.equal(registry.getPausedChildren().length, 0);
    } finally {
      await h.emit("session_shutdown", {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cancels independent reviewers instead of pausing a run that cannot resume", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-pause-reviewer-"));
    const h = harness({ dir });
    const reviewer = child({
      id: "p-reviewer",
      status: "running",
      purpose: "review",
      reviewRunId: "sr-1",
      reviewLens: "readiness",
      targetHash: "a".repeat(64),
    });
    registry.registerChild(reviewer);

    try {
      await pause(h);

      const row = registry.getChildById("p-reviewer")!;
      assert.equal(row.status, "closed");
      assert.equal(row.closeReason, "scope-cancelled", "a reviewer must not claim to be resumable");
      assert.equal(registry.getPausedChildren().length, 0, "the paused set is for workers, not reviewers");
      assert.match(h.notices.at(-1)!.text, /cannot resume/);
      assert.match(h.notices.at(-1)!.text, /agent_spec_review/);
    } finally {
      await h.emit("session_shutdown", {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("/agent-resume redeploys the paused run on its own sessions", () => {
  beforeEach(() => registry.resetForTests());

  it("starts each paused child against its previous session file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-resume-"));
    // Normal mode: an unreviewed worker may resume here. Orchestrator's spec gate
    // has its own regression test below.
    const h = harness({ dir, modeId: null });
    const first = child({ id: "r-first", sessionFile: join(dir, "first.jsonl") });
    const second = child({ id: "r-second", sessionFile: join(dir, "second.jsonl") });
    await writeFile(first.sessionFile, "{}\n", "utf8");
    await writeFile(second.sessionFile, "{}\n", "utf8");
    const pausedAt = new Date().toISOString();
    registry.registerChild({ ...first, status: "closed", closeReason: "paused", closedAt: pausedAt });
    registry.registerChild({ ...second, status: "closed", closeReason: "paused", closedAt: pausedAt });
    registry.setPaused(true);

    try {
      assert.equal(registry.getPausedChildren().length, 2);

      await resume(h);

      assert.equal(h.calls.start.length, 2, "one pane per paused child");
      assert.equal(registry.isPaused(), false);
      assert.equal(registry.getPausedChildren().length, 0, "resumed rows are superseded, not still paused");
      const rows = [first, second].map((c) => registry.getChildBySession(c.sessionFile)!);
      for (const row of rows) {
        assert.equal(row.status, "running", "the redeployed child owns the row again");
        assert.ok(row.paneId?.startsWith("w9:"), "the paused child came back in a fresh pane");
      }
      assert.notEqual(rows[0].paneId, rows[1].paneId);
      assert.match(h.notices.at(-1)!.text, /Redeployed 2 child/);
    } finally {
      await h.emit("session_shutdown", {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says there is nothing to resume instead of inventing work", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-resume-"));
    const h = harness({ dir });

    try {
      await resume(h);

      assert.equal(h.calls.start.length, 0);
      assert.match(h.notices.at(-1)!.text, /Nothing to resume/);
      assert.equal(registry.isPaused(), false);
    } finally {
      await h.emit("session_shutdown", {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks a paused child with no session file as paused-missing and keeps going", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-resume-"));
    const h = harness({ dir, modeId: null });
    const alive = child({ id: "r-alive", sessionFile: join(dir, "alive.jsonl") });
    const lost = child({ id: "r-lost", sessionFile: join(dir, "missing.jsonl") });
    await writeFile(alive.sessionFile, "{}\n", "utf8");
    const pausedAt = new Date().toISOString();
    registry.registerChild({ ...alive, status: "closed", closeReason: "paused", closedAt: pausedAt });
    registry.registerChild({ ...lost, status: "closed", closeReason: "paused", closedAt: pausedAt });
    registry.setPaused(true);

    try {
      await resume(h);

      const lostRow = registry.getChildById(lost.id)!;
      assert.equal(lostRow.status, "closed");
      assert.equal(lostRow.closeReason, "paused-missing");
      assert.equal(h.calls.start.length, 1, "only the child whose session survived was redeployed");
      assert.equal(registry.getChildBySession(alive.sessionFile)!.status, "running");
      assert.equal(h.notices.at(-1)!.level, "warning");
      assert.match(h.notices.at(-1)!.text, /paused-missing/);
    } finally {
      await h.emit("session_shutdown", {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves a pause from normal mode, but still refuses when nothing was paused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-resume-"));
    const paused = child({ id: "r-any-mode", sessionFile: join(dir, "any.jsonl") });
    await writeFile(paused.sessionFile, "{}\n", "utf8");
    registry.registerChild(paused);

    const orchestrator = harness({ dir });
    try {
      await pause(orchestrator);
      registry.resetForTests();
      // Rebuild the paused state a restart would have restored from the sidecar.
      registry.registerChild({ ...paused, status: "closed", closeReason: "paused", closedAt: new Date().toISOString() });
      registry.setPaused(true);
    } finally {
      await orchestrator.emit("session_shutdown", {});
    }

    const normal = harness({ dir, modeId: null });
    try {
      await resume(normal);
      assert.equal(normal.calls.start.length, 1, "an owned pause is resumable without re-entering orchestrator mode");
      assert.equal(registry.isPaused(), false);
    } finally {
      await normal.emit("session_shutdown", {});
      await rm(dir, { recursive: true, force: true });
    }

    const clean = harness({ dir, modeId: null });
    try {
      await resume(clean);
      assert.equal(clean.calls.start.length, 0);
      assert.match(clean.notices.at(-1)!.text, /Nothing to resume/);
    } finally {
      await clean.emit("session_shutdown", {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});
