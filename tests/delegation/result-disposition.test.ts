import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import agentExtension, { registry } from "../../extensions/agent.ts";
import type { ScopedChild } from "../../lib/delegation/scope-registry.ts";

// Global config must not leak host ceilings or role bindings into these tests.
process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "disposition-agent-config");
delete process.env.PI_SUBAGENT_MAX_CHILDREN;

function ownedChild(id: string, status: ScopedChild["status"]): ScopedChild {
  return {
    id,
    name: `Worker ${id}`,
    scope: `scope-${id}`,
    sessionFile: `/tmp/disposition-tests/${id}.jsonl`,
    status,
    laneFiles: ["src/unit-a/"],
    lastMilestoneFiles: [],
    updatedAt: "2026-01-01",
    accountability: {
      ownerSessionId: "sess-owner",
      batchId: "sess-owner:1",
      workUnitKey: `unit-${id}`,
      delegationReason: "independent lane work",
      reviewPlan: "inspect the diff and run the tests",
      resultRevision: 0,
      disposition: "pending",
      reviews: [],
      attempts: [],
    },
  };
}

function harness() {
  const hooks = new Map<string, Function[]>();
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
  const tools = new Map<string, any>();
  agentExtension(pi, {
    client: {} as any,
    stream: { watch: () => () => {}, onReconcile: () => () => {} },
  });
  const emit = async (name: string, event: any = {}): Promise<void> => {
    for (const fn of hooks.get(name) ?? []) await fn(event, ctxStub);
  };
  const ctxStub: any = {
    mode: "rpc",
    cwd: tmpdir(),
    ui: { notify() {} },
    sessionManager: {
      getSessionFile: () => "/tmp/disposition-tests/parent.jsonl",
      getSessionId: () => "sess-owner",
      getSessionDir: () => "/tmp/disposition-tests/sessions",
    },
  };
  const accept = tools.get("agent_accept_result");
  // The request context supplies the owning session, exactly as production does.
  const run = (args: Record<string, unknown>) => accept.execute("t", args, undefined, undefined, ctxStub);
  return { run, emit };
}

const acceptArgs = {
  disposition: "accepted" as const,
  resultRevision: 1,
  summary: "Verified the diff and ran the suite myself",
  evidence: ["ran npm test, all green", "inspected src/unit-a/agent.ts"],
  integration: "Merged into the batch; integration check still owed",
};

test("an accepted disposition records evidence and releases the review slot", async () => {
  registry.resetForTests();
  const { run } = harness();
  registry.registerChild(ownedChild("acc-1", "running"));
  registry.updateStatus("/tmp/disposition-tests/acc-1.jsonl", "completed"); // revision 0 -> 1

  const result = await run({ childId: "acc-1", ...acceptArgs });
  assert.match(String(result.content?.[0]?.text), /dispositioned: accepted/);
  const row = registry.getChildById("acc-1")!;
  assert.equal(row.accountability!.disposition, "accepted");
  assert.deepEqual(row.accountability!.reviews.at(-1)!.evidence.length, acceptArgs.evidence.length);
  assert.equal(registry.getOccupiedChildren("sess-owner").length, 0, "the slot is released");
  assert.equal(registry.getPendingResults("sess-owner").length, 0);
});

test("a still-active child cannot be dispositioned", async () => {
  registry.resetForTests();
  const { run } = harness();
  registry.registerChild(ownedChild("live-1", "running"));
  const result = await run({ childId: "live-1", ...acceptArgs, integration: "n/a" });
  assert.equal(result.details.error, "child-active");
  assert.match(String(result.content?.[0]?.text), /still active/);
});

test("unknown child, wrong owner, stale revision and settled results are refused", async () => {
  registry.resetForTests();
  const { run } = harness();
  registry.registerChild(ownedChild("gone-1", "completed"));
  registry.updateStatus("/tmp/disposition-tests/gone-1.jsonl", "closed", {});

  const unknown = await run({ childId: "nobody", ...acceptArgs });
  assert.equal(unknown.details.error, "unknown-or-not-owned");

  const wrongOwner = ownedChild("foreign-1", "completed");
  wrongOwner.sessionFile = "/tmp/disposition-tests/foreign-1.jsonl";
  wrongOwner.accountability = { ...wrongOwner.accountability!, ownerSessionId: "sess-other" };
  registry.registerChild(wrongOwner);
  const foreign = await run({ childId: "foreign-1", ...acceptArgs });
  assert.equal(foreign.details.error, "unknown-or-not-owned");

  const stale = await run({ childId: "gone-1", ...acceptArgs, resultRevision: 99 });
  assert.equal(stale.details.error, "stale-result");
});

test("accepted requires checked evidence; a settled result refuses a second verdict", async () => {
  registry.resetForTests();
  const { run } = harness();
  registry.registerChild(ownedChild("ev-1", "running"));
  registry.updateStatus("/tmp/disposition-tests/ev-1.jsonl", "completed");

  const noEvidence = await run({ childId: "ev-1", ...acceptArgs, evidence: [] });
  assert.equal(noEvidence.details.error, "evidence-required");

  await run({ childId: "ev-1", ...acceptArgs });
  const again = await run({ childId: "ev-1", ...acceptArgs, disposition: "abandoned" } as any);
  assert.equal(again.details.error, "already-settled");
});

test("changes-requested keeps the slot occupied by the same work unit", async () => {
  registry.resetForTests();
  const { run } = harness();
  registry.registerChild(ownedChild("rework-1", "running"));
  registry.updateStatus("/tmp/disposition-tests/rework-1.jsonl", "completed");

  const result = await run({
    childId: "rework-1",
    disposition: "changes-requested",
    resultRevision: 1,
    summary: "Criteria 2 and 3 failed: flaky on collision",
    integration: "will steer the same child",
  });
  assert.match(String(result.content?.[0]?.text), /steer or resume the SAME child/);
  assert.equal(registry.getOccupiedChildren("sess-owner").length, 1, "still owned");
  assert.equal(registry.getPendingResults("sess-owner").length, 0, "no longer pending-review");
});

test("an abandoned result is recorded as wasted work, not success, with cleanup notes", async () => {
  registry.resetForTests();
  const { run } = harness();
  registry.registerChild(ownedChild("waste-1", "running"));
  registry.updateStatus("/tmp/disposition-tests/waste-1.jsonl", "completed");

  const result = await run({
    childId: "waste-1",
    disposition: "abandoned",
    resultRevision: 1,
    summary: "Wrong work-unit key; superset already shipped",
    integration: "Left an uncommitted src/unit-a/patch.ts — needs manual revert",
  });
  assert.match(String(result.content?.[0]?.text), /Recorded as wasted work/);
  const row = registry.getChildById("waste-1")!;
  assert.equal(row.accountability!.disposition, "abandoned");
  assert.equal(registry.getOccupiedChildren("sess-owner").length, 0);
  // An abandoned record is not acceptance evidence for integration checks.
  assert.ok(row.accountability!.reviews[0].integration.includes("revert"));
});
