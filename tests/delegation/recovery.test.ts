import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { decideRecovery, emptyRecovery, retryDelayMs } from "../../lib/delegation/recovery.ts";

const pool = ["a/one", "b/two", "c/three"];

describe("recovery policy", () => {
  it("retries a transient failure on the same model first, with backoff", () => {
    const d = decideRecovery({ errorClass: "transient", state: emptyRecovery(), candidates: pool });
    assert.deepEqual(d, { action: "retry", attempt: 1, delayMs: 15_000 });
    assert.equal(retryDelayMs(10), 600_000);
    assert.equal(retryDelayMs(0, 60_000), 65_000);
  });

  it("fails over once retries on the model are spent", () => {
    const d = decideRecovery({ errorClass: "transient", state: { attempts: 3, failovers: 0, tried: ["a/one"] }, candidates: pool });
    assert.deepEqual(d, { action: "failover", model: "b/two", delayMs: 5_000 });
  });

  it("quota, config and auth fail over immediately, skipping tried models", () => {
    for (const errorClass of ["quota", "config", "auth"] as const) {
      const d = decideRecovery({ errorClass, state: { attempts: 0, failovers: 1, tried: ["a/one", "b/two"] }, candidates: pool });
      assert.equal(d.action === "failover" && d.model, "c/three");
    }
  });

  it("escalates when nothing is left, saying why", () => {
    const none = decideRecovery({ errorClass: "quota", state: emptyRecovery(), candidates: [] });
    assert.equal(none.action, "escalate");
    assert.match((none as any).reason, /no alternative model/);
    const spent = decideRecovery({ errorClass: "quota", state: { attempts: 0, failovers: 0, tried: pool }, candidates: pool });
    assert.match((spent as any).reason, /every model/);
    const capped = decideRecovery({ errorClass: "quota", state: { attempts: 0, failovers: 3, tried: [] }, candidates: pool });
    assert.match((capped as any).reason, /failovers already spent/);
  });

  it("never auto-handles an abort or an unknown failure", () => {
    assert.equal(decideRecovery({ errorClass: "aborted", state: emptyRecovery(), candidates: pool }).action, "escalate");
    assert.equal(decideRecovery({ errorClass: "unknown", state: emptyRecovery(), candidates: pool }).action, "escalate");
  });
});

import agentExtension, { registry } from "../../extensions/agent.ts";
import type { ScopedChild } from "../../lib/delegation/scope-registry.ts";

describe("a resume keeps the work unit's history", () => {
  it("carries recovery state and the spawn-time tree baseline to the new row", () => {
    registry.resetForTests();
    const row = (id: string): ScopedChild => ({
      id, name: "W", scope: "s", sessionFile: "/tmp/recovery/s.jsonl", status: "failed", laneFiles: [], lastMilestoneFiles: [], updatedAt: "x",
      accountability: { ownerSessionId: "o", batchId: "b", workUnitKey: "u", delegationReason: "r", reviewPlan: "p", resultRevision: 0, disposition: "pending", reviews: [], attempts: [] },
    });
    const first = row("a");
    first.recovery = { attempts: 1, failovers: 1, tried: ["x/one"], dueAt: 123, action: "failover", model: "y/two" };
    first.baselineTree = { "src/a.ts": "1:1" };
    registry.registerChild(first);
    registry.registerChild(row("b")); // the resume
    const resumed = registry.getChildById("b")!;
    assert.deepEqual(resumed.recovery?.tried, ["x/one"]);
    assert.equal(resumed.recovery?.failovers, 1);
    assert.deepEqual(resumed.baselineTree, { "src/a.ts": "1:1" });
  });
});

describe("headless parent holds the run open for children", () => {
  it("waits in agent_before_settle until no child is in flight", async () => {
    registry.resetForTests();
    const hooks = new Map<string, Function>();
    agentExtension(
      { registerTool() {}, registerCommand() {}, on: (n: string, f: Function) => hooks.set(n, f), getAllTools: () => [], events: undefined } as any,
      { client: {} as any, stream: { watch: () => () => {}, onReconcile: () => () => {} } },
    );
    const child = (): ScopedChild => ({
      id: "h1", name: "W", scope: "s", sessionFile: "/tmp/headless/s.jsonl", status: "running", laneFiles: [], lastMilestoneFiles: [], updatedAt: "x",
      accountability: { ownerSessionId: "o", batchId: "b", workUnitKey: "u", delegationReason: "r", reviewPlan: "p", resultRevision: 0, disposition: "pending", reviews: [], attempts: [] },
    });
    registry.registerChild(child());
    const ctx: any = { hasUI: false, sessionManager: { getSessionId: () => "o" } };
    let returned = false;
    const waiting = (hooks.get("agent_before_settle") as Function)({}, ctx).then(() => { returned = true; });
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(returned, false, "still held open while a child runs");
    registry.updateStatus("/tmp/headless/s.jsonl", "completed");
    await waiting;
    assert.equal(returned, true);
    registry.resetForTests();
  });
});
