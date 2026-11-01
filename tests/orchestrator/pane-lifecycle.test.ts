import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import agentExtension, {
  budgetNotice,
  registry,
  stallNotice,
  watchdogSeams,
} from "../../extensions/agent.ts";

// The lane check is computed from git in production. These cases are about
// lifecycle, so they supply an empty change list instead of depending on the
// repository the suite happens to run in.
import type { ScopedChild } from "../../lib/orchestrator/scope-registry.ts";

interface Harness {
  tools: Map<string, any>;
  messages: Array<{ message: any; options: any }>;
  entries: Array<{ type: string; data: any }>;
  calls: { keys: Array<{ paneId: string; keys: string[] }>; close: string[]; start: any[] };
  client: any;
  emit: (name: string, event: any, ctx: any) => Promise<any[]>;
}

function harness(options: {
  paneRead?: (paneId: string, lines?: number) => Promise<string | null>;
  paneGet?: (paneId: string) => Promise<{ pane_id?: string } | null>;
  paneSendKeys?: (paneId: string, keys: string[]) => Promise<void>;
  paneClose?: (paneId: string) => Promise<void>;
  paneList?: () => Promise<Array<{ pane_id: string }>>;
  now?: () => number;
} = {}): Harness {
  const tools = new Map<string, any>();
  const hooks = new Map<string, Function[]>();
  const messages: Harness["messages"] = [];
  const entries: Harness["entries"] = [];
  const calls: Harness["calls"] = { keys: [], close: [], start: [] };

  const client: any = {
    paneGet: options.paneGet ?? (async (paneId: string) => ({ pane_id: paneId })),
    paneRead: options.paneRead ?? (async () => "user@box:~$ "),
    paneList: options.paneList ?? (async () => []),
    paneSendKeys:
      options.paneSendKeys ??
      (async (paneId: string, keys: string[]) => {
        calls.keys.push({ paneId, keys });
      }),
    paneClose:
      options.paneClose ??
      (async (paneId: string) => {
        calls.close.push(paneId);
      }),
    paneStart: async (plan: any) => {
      calls.start.push(plan);
      return { paneId: "w9:p1" };
    },
  };

  const pi: any = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on(name: string, fn: Function) {
      hooks.set(name, [...(hooks.get(name) ?? []), fn]);
    },
    sendMessage(message: any, opts: any) {
      messages.push({ message, options: opts });
    },
    appendEntry(type: string, data: any) {
      entries.push({ type, data });
    },
    getAllTools() {
      return [...tools.values()];
    },
  };

  // The interval timer is not what these tests drive; session_start is emitted
  // explicitly by the tests that need restore/sweep behaviour.
  agentExtension(pi, {
    client,
    stream: { watch: () => () => {}, onReconcile: () => () => {} },
    now: options.now ?? (() => 10_000_000),
    watchdogIntervalMs: 30_000,
  });

  const emit = async (name: string, event: any, ctx: any) => {
    const results: any[] = [];
    for (const fn of hooks.get(name) ?? []) results.push(await fn(event, ctx));
    return results.filter(Boolean);
  };

  return { tools, messages, entries, calls, client, emit };
}

let seq = 0;

function child(partial: Partial<ScopedChild> = {}): ScopedChild {
  const id = partial.id ?? `run-${++seq}`;
  return {
    id,
    name: `Worker ${id}`,
    scope: `scope-${id}`,
    sessionFile: `/tmp/orchestrator-tests/${id}.jsonl`,
    paneId: `w1:p${++seq}`,
    status: "running",
    laneFiles: ["src/x/"],
    lastMilestoneFiles: [],
    updatedAt: new Date(0).toISOString(),
    startedAt: 0,
    budgetMs: 30 * 60_000,
    watchdog: { trip: null, interrupts: 0 },
    ...partial,
  } as ScopedChild;
}

async function tick(times = 1): Promise<void> {
  assert.ok(watchdogSeams.tick, "watchdog tick seam is installed by the extension");
  for (let i = 0; i < times; i++) await watchdogSeams.tick!();
}

describe("watchdog: one notice per trip", () => {
  it("a budget trip notifies once and interrupts once across many ticks", async () => {
    const h = harness({ now: () => 10_000_000 });
    const c = child({ id: "budget-once", startedAt: 0, budgetMs: 60_000 });
    registry.registerChild(c);

    await tick(5);

    assert.equal(h.messages.length, 1, "exactly one notice, not one per tick");
    assert.equal(h.calls.keys.length, 1, "exactly one Escape, not one per tick");
    assert.deepEqual(h.calls.keys[0].keys, ["esc"]);
    assert.equal(h.messages[0].message.details.reason, "budget-exceeded");
    assert.equal(h.messages[0].options.deliverAs, "followUp", "a notice must not preempt a turn");

    const row = registry.getChildById(c.id)!;
    assert.equal(row.status, "blocked");
    assert.equal(row.watchdog?.trip, "budget-exceeded");
    assert.equal(row.watchdog?.interrupts, 1);
  });

  it("a vanished pane closes the child instead of notifying", async () => {
    // paneGet is the existence oracle: null means the pane is gone. Liveness must
    // read that value, not infer death from a failed diagnostic read.
    const h = harness({ paneGet: async () => null });
    const c = child({ id: "pane-gone", startedAt: 0, budgetMs: 60_000 });
    registry.registerChild(c);

    await tick(3);

    assert.equal(h.messages.length, 1, "one dismissal, not one per tick");
    assert.equal(h.messages[0].message.details.reason, "pane-gone");
    assert.match(h.messages[0].message.content, /ended without a report/);
    assert.equal(h.calls.keys.length, 0, "nothing was typed into a dead pane");
    const row = registry.getChildById(c.id)!;
    assert.equal(row.status, "closed");
    assert.equal(row.closeReason, "pane-gone");
  });

  it("two rows for one session file produce one verdict", async () => {
    const h = harness({ now: () => 10_000_000 });
    const sessionFile = "/tmp/orchestrator-tests/dup-session.jsonl";
    registry.registerChild(child({ id: "dup-old", sessionFile, startedAt: 0, budgetMs: 45 * 60_000 }));
    registry.registerChild(child({ id: "dup-new", sessionFile, startedAt: 0, budgetMs: 60_000 }));

    await tick(4);

    assert.equal(h.messages.length, 1, "one child, one notice — not one per id");
    assert.equal(h.messages[0].message.details.budgetMs, 60_000, "the superseding row's budget wins");
    assert.equal(registry.getAllChildren().filter((c) => c.sessionFile === sessionFile).length, 1);
  });

  it("the interrupt cooldown keeps a static pane from being called a stall", async () => {
    const h = harness({ now: () => 1_000_000 });
    const c = child({ id: "stall-cooldown", startedAt: 1_000_000, budgetMs: 30 * 60_000 });
    registry.registerChild(c);
    registry.updateWatchdog(c.sessionFile, {
      interruptSentAt: new Date(1_000_000).toISOString(),
      addInterrupt: true,
    });
    registry.updateRuntime(c.sessionFile, { lastTail: "user@box:~$ ", stallStrikes: 2 });

    await tick(4);

    assert.equal(h.calls.keys.length, 0, "no second Escape after an interrupt");
    assert.equal(h.messages.length, 0);
    assert.equal(registry.getChildById(c.id)?.stallStrikes, 0);
  });
});

describe("pane lifecycle: close is a terminal transition", () => {
  it("agent_close closes a live pane and marks the row closed", async () => {
    const h = harness();
    const c = child({ id: "close-live" });
    registry.registerChild(c);

    const result = await h.tools.get("agent_close").execute("t", { id: c.id, reason: "done" });

    assert.deepEqual(h.calls.close, [c.paneId]);
    const row = registry.getChildById(c.id)!;
    assert.equal(row.status, "closed");
    assert.equal(row.closeReason, "user-closed");
    assert.ok(row.closedAt);
    assert.equal((result.details as any).paneState, "closed");
    // The checkpoints panel reads branch entries, not the registry: without a
    // terminal entry a closed child kept showing "unverified (last known running)"
    // — a pending subagent whose pane was already closed.
    const checkpoint = h.entries.find(entry => entry.type === "subagent-checkpoint:v1");
    assert.ok(checkpoint, "closing a child must end its checkpoint record");
    assert.equal(checkpoint.data.sessionFile, c.sessionFile);
    assert.equal(checkpoint.data.status, "closed");
    assert.equal(checkpoint.data.ended, true);
  });

  it("agent_close is idempotent when the pane is already gone", async () => {
    const h = harness({ paneGet: async () => null });
    const c = child({ id: "close-gone" });
    registry.registerChild(c);

    const first = await h.tools.get("agent_close").execute("t", { id: c.id });
    assert.equal(h.calls.close.length, 0, "nothing to close");
    assert.equal((first.details as any).paneState, "already-gone");
    assert.equal(registry.getChildById(c.id)?.status, "closed");

    const second = await h.tools.get("agent_close").execute("t", { id: c.id });
    assert.match(second.content[0].text, /already closed/);
  });

  it("agent_interrupt with close:true interrupts then closes", async () => {
    const h = harness();
    const c = child({ id: "interrupt-close" });
    registry.registerChild(c);

    const result = await h.tools.get("agent_interrupt").execute("t", { id: c.id, close: true });

    assert.deepEqual(h.calls.keys, [{ paneId: c.paneId, keys: ["esc"] }]);
    assert.deepEqual(h.calls.close, [c.paneId]);
    assert.equal(registry.getChildById(c.id)?.closeReason, "interrupted");
    assert.equal((result.details as any).status, "closed");
  });

  it("agent_interrupt reconciles a vanished pane instead of failing", async () => {
    const h = harness({ paneGet: async () => null });
    const c = child({ id: "interrupt-gone" });
    registry.registerChild(c);

    const result = await h.tools.get("agent_interrupt").execute("t", { id: c.id });

    assert.equal((result.details as any).status, "already-gone");
    assert.equal(h.calls.keys.length, 0);
    assert.equal(h.calls.close.length, 0);
    assert.equal(registry.getChildById(c.id)?.status, "closed");
  });

});

describe("watchdog notices describe what actually happened", () => {
  it("a dead pane is not reported as an interrupt", () => {
    const notInterrupted = budgetNotice({
      name: "w",
      scope: "s",
      elapsedMs: 60_000,
      budgetMs: 60_000,
      interrupted: false,
    });
    assert.match(notInterrupted, /pane is gone/);
    assert.doesNotMatch(notInterrupted, /It was interrupted/);

    const interrupted = budgetNotice({
      name: "w",
      scope: "s",
      elapsedMs: 60_000,
      budgetMs: 60_000,
      interrupted: true,
    });
    assert.match(interrupted, /interrupted \(Esc\)/);
  });

  it("a stall notice keeps the strikes and the observation", () => {
    const notice = stallNotice({
      name: "w",
      scope: "s",
      strikes: 3,
      intervalMs: 30_000,
      interrupted: false,
    });
    assert.match(notice, /3 consecutive checks/);
    assert.match(notice, /pane is gone/);
    assert.doesNotMatch(notice, /It was interrupted/);
  });
});

describe("ownership survives a failed probe", () => {
  it("an unreachable herdr does not close a live child", async () => {
    const h = harness({
      paneGet: async () => {
        throw new Error("herdr: connection reset");
      },
    });
    const c = child({ id: "unknown-liveness", startedAt: 0, budgetMs: 60_000 });
    registry.registerChild(c);

    await tick(3);

    assert.equal(h.messages.length, 0, "a probe that proved nothing sends no notice");
    assert.equal(h.calls.close.length, 0, "a live child is not closed on a failed probe");
    const row = registry.getChildById(c.id)!;
    assert.equal(row.status, "running");
    assert.equal(row.watchdog?.trip, null);
  });

  it("a failed interrupt stays in the watchdog, then closes the child", async () => {
    let clock = 10_000_000;
    const h = harness({
      now: () => clock,
      paneSendKeys: async () => {
        throw new Error("pane refused keys");
      },
    });
    const c = child({ id: "no-interrupt", startedAt: 0, budgetMs: 60_000 });
    registry.registerChild(c);
    const notices = () => h.messages.filter((m) => m.message?.details?.id === c.id);

    await tick(1);
    let row = registry.getChildById(c.id)!;
    assert.equal(row.status, "running", "a failed Esc must not park the child");
    assert.equal(row.watchdog?.trip, "budget-exceeded");
    assert.equal(row.watchdog?.interruptFailures, 1);
    assert.equal(notices().length, 1, "the parent is told the interrupt did not land");

    // Backoff elapses; the second attempt is the last: the watchdog ends it.
    clock += 90_000;
    await tick(1);
    row = registry.getChildById(c.id)!;
    assert.equal(row.status, "closed");
    assert.equal(row.closeReason, "interrupt-failed");
    assert.ok(h.calls.close.includes(c.paneId!), "the pane was actually closed");
  });

  it("a failed close keeps the child under watchdog retry instead of parking it", async () => {
    let clock = 10_000_000;
    const c = child({ id: "close-retry", status: "blocked" });
    let attempts = 0;
    const h = harness({
      now: () => clock,
      paneClose: async (paneId: string) => {
        if (paneId !== c.paneId) return; // other rows share this module-level registry
        attempts++;
        if (attempts === 1) throw new Error("permission denied");
        h.calls.close.push(paneId);
      },
    });
    registry.registerChild(c);

    const first = await h.tools.get("agent_close").execute("t", { id: c.id });
    assert.equal((first.details as any).error, "permission denied");
    let row = registry.getChildById(c.id)!;
    assert.equal(row.status, "running", "a live pane must not sit in a status the watchdog ignores");
    assert.equal(row.watchdog?.trip, "close-failed");

    clock += 90_000;
    await tick(1);
    row = registry.getChildById(c.id)!;
    assert.equal(row.status, "closed");
    assert.ok(h.calls.close.includes(c.paneId!));
  });
});

describe("targets and scopes stay honest after a close", () => {
  it("agent_steer refuses a finished child instead of reviving it", async () => {
    const h = harness();
    const c = child({ id: "steer-closed", status: "closed", closeReason: "review-approved" });
    registry.registerChild(c);

    const result = await h.tools.get("agent_steer").execute("t", { id: c.id, message: "keep going" });

    assert.equal((result.details as any).error, "stale-target");
    assert.equal((result.details as any).childStatus, "closed");
  });

  it("resume refuses to start a second process while the old pane is alive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-resume-"));
    try {
      const sessionPath = join(dir, "child.jsonl");
      await writeFile(sessionPath, "{}\n", "utf8");
      const h = harness({
        paneClose: async () => {
          throw new Error("permission denied");
        },
      });
      const c = child({ id: "resume-live", sessionFile: sessionPath, paneId: "w1:live" });
      registry.registerChild(c);
      const ctx: any = {
        cwd: dir,
        sessionManager: {
          getSessionDir: () => dir,
          getSessionId: () => "parent-test",
          getSessionFile: () => join(dir, "parent.jsonl"),
        },
      };

      const result = await h.tools
        .get("agent_resume")
        .execute("t", { sessionPath, message: "go" }, undefined, undefined, ctx);

      assert.equal((result.details as any).error, "resume-aborted");
      assert.equal(h.calls.start.length, 0, "no second pane for a session file with a live pane");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("orphan sweep is attributed, never guessed", () => {
  it("closes a pane this parent opened and refuses to touch a stranger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-sweep-"));
    try {
      await writeFile(
        join(dir, "main-agent-registry-parent-sweep.json"),
        JSON.stringify({
          version: 1,
          savedAt: new Date(0).toISOString(),
          children: [],
          steers: [],
          reviews: [],
          panes: ["w1:orphan"],
          handoffs: [],
          escalations: [],
        }),
        "utf8",
      );
      const h = harness({
        paneList: async () => [{ pane_id: "w1:orphan" }, { pane_id: "w1:stranger" }],
      });
      const ctx: any = {
        sessionManager: {
          getSessionDir: () => dir,
          getSessionId: () => "parent-sweep",
          getSessionFile: () => join(dir, "p.jsonl"),
          getBranch: () => [],
        },
        ui: { notify() {} },
      };

      await h.emit("session_start", { type: "session_start" }, ctx);

      assert.deepEqual(h.calls.close, ["w1:orphan"], "only a pane this parent opened is closed");
      assert.ok(!h.calls.close.includes("w1:stranger"), "an unattributed pane is never touched");

      // Real shutdown clears the watchdog interval; leaving it armed would keep
      // this test process alive after the assertions are done.
      await h.emit("session_shutdown", {}, ctx);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
