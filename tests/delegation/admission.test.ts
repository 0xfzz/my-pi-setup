import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  admissionProblem,
  DEFAULT_CONCURRENT_DELEGATIONS,
  DEFAULT_LAUNCHES_PER_BATCH,
  outstandingLaunchSlots,
  releaseLaunchSlot,
  reserveLaunchSlot,
  resetLaunchReservations,
  resolveBudgets,
} from "../../lib/delegation/admission.ts";
import agentExtension, { registry } from "../../extensions/agent.ts";

// resolveBudgets honours operator environment sources so a migrated setup keeps
// the ceiling its owner chose, and loadSubagentSettings reads the host's global
// config. Neither may change this file's arithmetic expectations, so the env
// source is removed and the config dir pinned to an empty location; the
// explicit-configuration rule is covered by the resolveBudgets unit case below.
delete process.env.PI_SUBAGENT_MAX_CHILDREN;
process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "admission-agent-config");

test("resolveBudgets defaults to 2 slots and 4 launches, honouring explicit configuration", () => {
  assert.deepEqual(resolveBudgets({}), {
    concurrent: DEFAULT_CONCURRENT_DELEGATIONS,
    launchesPerBatch: DEFAULT_LAUNCHES_PER_BATCH,
  });
  // A migrated setup keeps the ceiling its owner chose: explicit wins over defaults.
  assert.equal(resolveBudgets({ maxDelegates: 5 }).concurrent, 5);
  // Strictest configured value applies.
  assert.equal(resolveBudgets({ maxDelegates: 5, maxConcurrentDelegations: 3 }).concurrent, 3);
  assert.equal(resolveBudgets({ maxLaunchesPerBatch: 7 }).launchesPerBatch, 7);
  // Garbage values fall back to defaults, never to 0 or NaN.
  assert.deepEqual(resolveBudgets({ maxDelegates: -2, maxLaunchesPerBatch: 0 }), {
    concurrent: DEFAULT_CONCURRENT_DELEGATIONS,
    launchesPerBatch: DEFAULT_LAUNCHES_PER_BATCH,
  });
});

const budgets = { concurrent: 2, launchesPerBatch: 4 };

const input = {
  occupied: 0,
  reserved: 0,
  launchesInBatch: 0,
  workUnitKey: "unit-a",
  delegationReason: "independent research on a separate lane",
  occupiedKeys: [] as string[],
  budgets,
};

test("admissionProblem enforces the reason and duplicate work units", () => {
  assert.equal(admissionProblem(input), undefined);
  assert.match(
    admissionProblem({ ...input, delegationReason: "  " })!,
    /delegationReason is required/,
  );
  assert.match(
    admissionProblem({ ...input, workUnitKey: "unit-a", occupiedKeys: ["unit-a"] })!,
    /already occupies a slot.*agent_steer|replaces/s,
  );
});

test("a reservation is held against both the concurrent cap and the batch budget", () => {
  // 1 occupied + 1 in-flight = at cap, admitted. Two in-flight over the cap: refused.
  assert.equal(admissionProblem({ ...input, occupied: 1, reserved: 1 }), undefined);
  assert.match(
    admissionProblem({ ...input, occupied: 1, reserved: 2 })!,
    /concurrency cap/,
  );
  // Budget: 3 launched + 1 in-flight is at the limit; the next parallel call is refused.
  assert.equal(admissionProblem({ ...input, launchesInBatch: 3, reserved: 1 }), undefined);
  assert.match(
    admissionProblem({ ...input, launchesInBatch: 3, reserved: 2 })!,
    /launch budget.*\/agent batch/s,
  );
});

test("launch reservations are synchronous and releasable", () => {
  resetLaunchReservations();
  assert.equal(outstandingLaunchSlots("sess"), 0);
  assert.equal(reserveLaunchSlot("sess"), 1);
  assert.equal(reserveLaunchSlot("sess"), 2);
  assert.equal(outstandingLaunchSlots("other"), 0);
  releaseLaunchSlot("sess");
  releaseLaunchSlot("sess");
  assert.equal(outstandingLaunchSlots("sess"), 0);
  releaseLaunchSlot("sess"); // release below zero is harmless
});

// ── integration: the admission gate inside agent_spawn ────────────────────────

function harness(dir: string) {
  const calls: { start: unknown[] } = { start: [] };
  const hooks = new Map<string, Function[]>();
  const client: any = {
    paneGet: async () => ({ pane_id: "w9:p1" }),
    paneRead: async () => "prompt$ ",
    paneList: async () => [],
    paneSendKeys: async () => {},
    paneClose: async () => {},
    paneStart: async (plan: unknown) => {
      calls.start.push(plan);
      return { paneId: `w7:p${calls.start.length}` };
    },
  };
  const ctx: any = {
    mode: "rpc",
    cwd: dir,
    ui: { notify() {} },
    sessionManager: {
      getSessionFile: () => join(dir, "parent.jsonl"),
      getSessionId: () => "sess-owner",
      getSessionDir: () => join(dir, "sessions"),
    },
  };
  // A successful spawn arms a watcher: an fs-watch handle plus a poll interval
  // keep the test process alive until they are torn down. session_shutdown
  // aborts the extension's watcher controller — the same path a real shutdown
  // takes — so it must be emitted in every test's finally.
  const emit = async (name: string, event: any = {}): Promise<void> => {
    for (const fn of hooks.get(name) ?? []) await fn(event, ctx);
  };
  return { client, ctx, calls, emit, spawnTool: spawnToolFor(hooks, client) };
}

// The extension registers agent_spawn bound to the client it was given, so each
// harness wires a fresh registration to ITS client and records hooks, instead
// of sharing one.
function spawnToolFor(hooks: Map<string, Function[]>, client: unknown): { execute: (...args: unknown[]) => Promise<any> } {
  const tools = new Map<string, any>();
  const pi: any = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on(name: string, fn: Function) {
      hooks.set(name, [...(hooks.get(name) ?? []), fn]);
    },
    getAllTools: () => [...tools.values()],
    events: undefined,
  };
  agentExtension(pi, {
    client: client as any,
    stream: { watch: () => () => {}, onReconcile: () => () => {} },
  });
  return tools.get("agent_spawn");
}

test("agent_spawn refuses a spawn with no delegation reason and leaves no trace", async () => {
  resetLaunchReservations();
  registry.resetForTests();
  const dir = await mkdtemp(join(tmpdir(), "admission-"));
  const h = harness(dir);
  try {
    const result = await h.spawnTool.execute("t", { task: "tidy one import", name: "tidy" }, undefined, undefined, h.ctx);
    assert.equal(result.details.error, "admission-refused");
    assert.equal(h.calls.start.length, 0, "no pane was started");
    assert.equal(registry.getAllChildren().length, 0, "no registration row");
    assert.equal(outstandingLaunchSlots("sess-owner"), 0, "no reservation leaked");
  } finally {
    await h.emit("session_shutdown");
    await rm(dir, { recursive: true, force: true });
  }
});

test("an admitted spawn registers durable accountability and charges the batch", async () => {
  resetLaunchReservations();
  registry.resetForTests();
  const dir = await mkdtemp(join(tmpdir(), "admission-"));
  const h = harness(dir);
  try {
    const result = await h.spawnTool.execute(
      "t",
      {
        task: "investigate flaky login test",
        name: "scout",
        delegationReason: "bounded substantial research the parent session cannot hold",
      },
      undefined,
      undefined,
      h.ctx,
    );
    assert.equal(h.calls.start.length, 1);
    assert.match(String(result.content?.[0]?.text), /Work unit: scout/);
    const child = registry.getAllChildren()[0];
    const a = child.accountability!;
    assert.equal(a.ownerSessionId, "sess-owner");
    assert.equal(a.workUnitKey, "scout");
    assert.match(a.delegationReason, /research/);
    assert.ok(a.reviewPlan.length > 10, "a review plan exists even when not declared");
    assert.equal(a.resultRevision, 0);
    assert.equal(a.disposition, "pending");
    assert.equal(registry.getBatch("sess-owner").launches, 1);
    assert.equal(outstandingLaunchSlots("sess-owner"), 0, "the registry owns the slot after arming");
  } finally {
    await h.emit("session_shutdown");
    await rm(dir, { recursive: true, force: true });
  }
});

test("launch failures release the slot, so a failed spawn does not eat capacity", async () => {
  resetLaunchReservations();
  registry.resetForTests();
  const dir = await mkdtemp(join(tmpdir(), "admission-"));
  const harnessData = harness(dir);
  harnessData.client.paneStart = async () => {
    throw new Error("herdr down");
  };
  try {
    const failed = await harnessData.spawnTool.execute(
      "t",
      { task: "first attempt", name: "first", delegationReason: "independent lane on the parser" },
      undefined,
      undefined,
      harnessData.ctx,
    );
    assert.match(String(failed.content?.[0]?.text), /Failed to start pane/);
    assert.equal(outstandingLaunchSlots("sess-owner"), 0, "reservation released");
    assert.equal(registry.getAllChildren().length, 0, "nothing registered");
    assert.equal(registry.getBatch("sess-owner").launches, 0, "no launch counted");
  } finally {
    await harnessData.emit("session_shutdown");
    await rm(dir, { recursive: true, force: true });
  }
});

test("duplicate work units and the concurrent cap are enforced across sequential spawns", async () => {
  resetLaunchReservations();
  registry.resetForTests();
  const dir = await mkdtemp(join(tmpdir(), "admission-"));
  const h = harness(dir);
  const spawn = (name: string, extra: Record<string, unknown> = {}) =>
    h.spawnTool.execute(
      "t",
      { task: `work ${name}`, name, delegationReason: "independent lane per module", ...extra },
      undefined,
      undefined,
      h.ctx,
    );
  try {
    await spawn("alpha");
    const duplicate = await spawn("alpha");
    assert.equal(duplicate.details.error, "admission-refused");
    assert.match(String(duplicate.content?.[0]?.text), /already occupies a slot/);
    assert.equal(h.calls.start.length, 1, "no pane for the duplicate");

    // Distinct unit: at the default cap of 2 this is admitted.
    await spawn("beta");
    assert.equal(registry.getOccupiedChildren("sess-owner").length, 2);
    const third = await spawn("gamma");
    assert.equal(third.details.error, "admission-refused");
    assert.match(String(third.content?.[0]?.text), /concurrency cap/);
    assert.equal(h.calls.start.length, 2, "no pane for the refused spawn");
    assert.equal(registry.getBatch("sess-owner").launches, 2);
  } finally {
    await h.emit("session_shutdown");
    await rm(dir, { recursive: true, force: true });
  }
});


