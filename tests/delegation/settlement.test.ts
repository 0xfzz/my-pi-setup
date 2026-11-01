import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agentExtension, { registry } from "../../extensions/agent.ts";
import type { ScopedChild } from "../../lib/delegation/scope-registry.ts";

// Host config must not leak ceilings or role bindings into these tests.
process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "settlement-agent-config");
delete process.env.PI_SUBAGENT_MAX_CHILDREN;

function pendingResult(id: string): ScopedChild {
  return {
    id,
    name: `Worker ${id}`,
    scope: `scope-${id}`,
    sessionFile: `/tmp/settlement-tests/${id}.jsonl`,
    status: "completed",
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
  agentExtension(
    {
      registerTool() {},
      registerCommand() {},
      on(name: string, fn: Function) {
        hooks.set(name, [...(hooks.get(name) ?? []), fn]);
      },
      getAllTools: () => [],
      events: undefined,
    } as any,
    { client: {} as any, stream: { watch: () => () => {}, onReconcile: () => () => {} } } as any,
  );
  const ctx: any = {
    mode: "rpc",
    cwd: tmpdir(),
    ui: { notify() {} },
    sessionManager: {
      getSessionFile: () => "/tmp/settlement-tests/parent.jsonl",
      getSessionId: () => "sess-owner",
      getSessionDir: () => "/tmp/settlement-tests/sessions",
    },
  };
  const settle = async (): Promise<any> => {
    const results: any[] = [];
    for (const fn of hooks.get("agent_before_settle") ?? []) {
      results.push(await fn({ type: "agent_before_settle", entries: [], continue: false }, ctx));
    }
    return results.at(-1);
  };
  return { settle };
}

test("a fresh pending result requests exactly one continuation that names the verdict tool", async () => {
  registry.resetForTests();
  const { settle } = harness();
  registry.registerChild(pendingResult("settle-1"));

  const first = await settle();
  assert.ok(first, "a boundary with unseen pending results asks for one more turn");
  assert.equal(first.continue, true);
  const entry = first.entries?.[0];
  assert.equal(entry.type, "custom_message");
  assert.match(entry.content, /agent_accept_result/);
  assert.match(entry.content, /resultRevision=0/);
  assert.match(entry.content, /is NOT an accepted result/);

  // Bounded: the same set never demands a second continuation.
  const second = await settle();
  assert.equal(second, undefined, "no repeated settling loop");
});

test("an unresolved review stays visible in agent_running even after the continuation", async () => {
  registry.resetForTests();
  const { settle } = harness();
  registry.registerChild(pendingResult("visible-1"));
  await settle();

  // agent_running must still show it, on its own revision, after the turn.
  registry.resetForTests();
  registry.registerChild(pendingResult("visible-2"));

  // And a DIFFERENT work unit entering pending review is a new set: one more turn.
  const again = await settle();
  assert.equal(again?.continue, true);
  assert.match(String(again?.entries?.[0]?.content), /visible-2/);
});

test("settlement yields while children are active; nothing fires on an empty registry", async () => {
  registry.resetForTests();
  const { settle } = harness();

  // Active work: the child events will re-trigger the parent, so yielding is
  // correct — a settle must not forge ahead of a live run.
  const busy = pendingResult("busy-1");
  busy.status = "running";
  registry.registerChild(busy);
  assert.equal(await settle(), undefined, "active children yield to the event loop");

  // Everything settled: an empty registry requests nothing.
  registry.resetForTests();
  assert.equal(await settle(), undefined, "nothing to ask for without obligations");
});

test("blocked escalation waits stay out of the settlement loop", async () => {
  registry.resetForTests();
  const { settle } = harness();
  const blocked = { ...pendingResult("paused-1"), status: "blocked" as const, pendingPing: true };
  registry.registerChild(blocked);
  assert.equal(await settle(), undefined, "active/blocked children yield to the event loop");
  // The obligation is not discharged: the row still occupies a slot and its
  // disposition stays pending until it terminates and is actually judged.
  assert.equal(registry.getOccupiedChildren("sess-owner").length, 1);
  assert.equal(registry.getChildById("paused-1")!.accountability!.disposition, "pending");
});

test("a recorded disposition stops the continuation demand for that result", async () => {
  registry.resetForTests();
  const { settle } = harness();
  registry.registerChild(pendingResult("judged-1"));
  const row = registry.getChildById("judged-1")!;
  row.accountability!.disposition = "accepted";
  row.accountability!.reviews.push({
    disposition: "accepted",
    resultRevision: row.accountability!.resultRevision,
    summary: "checked",
    evidence: ["ran the tests"],
    integration: "absorbed",
    at: "2026-01-02",
  });

  const after = await settle();
  assert.equal(after, undefined, "no continuation is owed after the verdict");
});
