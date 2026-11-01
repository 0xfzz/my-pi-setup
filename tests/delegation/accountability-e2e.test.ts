import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import agentExtension, { registry } from "../../extensions/agent.ts";
import type { ScopedChild } from "../../lib/delegation/scope-registry.ts";

// Host config must not leak ceilings or role bindings into these tests.
process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "e2e-agent-config");
delete process.env.PI_SUBAGENT_MAX_CHILDREN;

function harness() {
  const calls: { start: unknown[] } = { start: [] };
  const commands = new Map<string, any>();
  const hooks = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const client: any = {
    paneGet: async () => ({ pane_id: "x" }),
    paneList: async () => [],
    paneStart: async (plan: unknown) => {
      calls.start.push(plan);
      return { paneId: `w7:p${calls.start.length}` };
    },
  };
  let dirRef = "";
  const ctx: any = {
    mode: "rpc",
    get cwd() {
      return dirRef;
    },
    ui: { notify() {} },
    sessionManager: {
      getSessionFile: () => join(dirRef, "parent.jsonl"),
      getSessionId: () => "sess-owner",
      getSessionDir: () => join(dirRef, "sessions"),
    },
  };
  agentExtension(
    {
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      registerCommand(name: string, definition: any) {
        commands.set(name, definition);
      },
      on(name: string, fn: Function) {
        hooks.set(name, [...(hooks.get(name) ?? []), fn]);
      },
      getAllTools: () => [...tools.values()],
      events: undefined,
    } as any,
    { client, stream: { watch: () => () => {}, onReconcile: () => () => {} } } as any,
  );
  const dir = async () => {
    dirRef = await mkdtemp(join(tmpdir(), "e2e-accountability-"));
    return dirRef;
  };
  return {
    spawn: (params: Record<string, unknown>) =>
      tools.get("agent_spawn").execute("t", params, undefined, undefined, ctx),
    accept: (params: Record<string, unknown>) =>
      tools.get("agent_accept_result").execute("t", params, undefined, undefined, ctx),
    batchReset: async () => commands.get("agent").handler("batch", ctx),
    dir,
    calls,
    cleanup: async () => {
      for (const fn of hooks.get("session_shutdown") ?? []) await fn({}, ctx);
      if (dirRef) await rm(dirRef, { recursive: true, force: true });
    },
  };
}

test("a launched child stays the parent's work until an evidence-backed verdict", async () => {
  registry.resetForTests();
  const h = await harness();
  await h.dir();
  try {
    // 1 · Admitted spawn: the reason is durable, so is the work unit.
    const start = await h.spawn({
      task: "fix the date parser edge case",
      name: "parser",
      laneFiles: ["src/parser/"],
      delegationReason: "bounded implementation on a distinct lane while the parent trails documents",
    });
    const details = start.details as any;
    assert.equal(details.status, "started");
    const child = registry.getChildById(details.id)!;
    assert.equal(child.accountability!.disposition, "pending");
    assert.equal(registry.getOccupiedChildren("sess-owner").length, 1);

    // 2 · The child finishes: its report arrives, but nothing is accepted.
    registry.updateStatus(child.sessionFile, "completed");
    assert.equal(child.accountability!.resultRevision, 1);
    assert.equal(registry.getPendingResults("sess-owner").length, 1);

    // 3 · An evidence-free acceptance is refused.
    const noEvidence = await h.accept({
      childId: child.id,
      disposition: "accepted",
      resultRevision: 1,
      summary: "looks fine to me",
      evidence: [],
      integration: "would merge",
    });
    assert.equal(noEvidence.details.error, "evidence-required");
    assert.equal(registry.getOccupiedChildren("sess-owner").length, 1, "nothing released by a naked accept");

    // 4 · The honest verdict for a partially credible report: changes requested.
    const rework = await h.accept({
      childId: child.id,
      disposition: "changes-requested",
      resultRevision: 1,
      summary: "criterion 2 unverified: no test output shown",
      integration: "steer the same child with the exact gap",
    });
    assert.match(String(rework.content?.[0]?.text), /steer or resume the SAME child/);
    assert.equal(registry.getOccupiedChildren("sess-owner").length, 1, "rework keeps the unit");

    // 5 · Rework through the SAME work unit (resume supersedes the attempt).
    const resumed: ScopedChild = {
      ...child,
      id: "rework-attempt",
      accountability: undefined as unknown as ScopedChild["accountability"],
    } as ScopedChild;
    registry.registerChild(resumed);
    const resumedRow = registry.getChildById("rework-attempt")!;
    assert.equal(resumedRow.accountability!.disposition, "pending", "rework reopens the obligation");
    assert.equal(resumedRow.accountability!.resultRevision, 2, "the superseded result is dead for verdicts");
    assert.ok(resumedRow.accountability!.attempts.some((a) => a.reviews[0].disposition === "changes-requested"));
    const stale = await h.accept({
      childId: child.id,
      disposition: "accepted",
      resultRevision: 1,
      summary: "belated acceptance of the superseded attempt",
      evidence: ["a stale receipt"],
      integration: "n/a",
    });
    assert.equal(stale.details.error, "stale-result", "a stale verdict cannot sneak past the revision gate");

    // 6 · The verified acceptance, on the CURRENT revision, with checked evidence.
    const accepted = await h.accept({
      childId: "rework-attempt",
      disposition: "accepted",
      resultRevision: 2,
      summary: "read the diff myself and ran the parser suite",
      evidence: ["ran node --test tests/parser/ — all green", "inspected src/parser/date.ts:40-60"],
      integration: "absorbed into the batch",
    });
    assert.match(String(accepted.content?.[0]?.text), /dispositioned: accepted/);
    assert.equal(registry.getOccupiedChildren("sess-owner").length, 0, "only acceptance releases the slot");
    assert.equal(registry.getBatch("sess-owner").launches, 1, "a reworked unit counted once");
  } finally {
    await h.cleanup();
  }
});

test("spawn caps cannot be bypassed by repetition, and the batch reset belongs to the user", async () => {
  registry.resetForTests();
  const h = await harness();
  await h.dir();
  try {
    const reason = "independent bounded research per unit";
    await h.spawn({ task: "unit one", name: "alpha", delegationReason: reason });
    const occupied = () => registry.getOccupiedChildren("sess-owner").length;

    // A finished child that was never dispositioned keeps its slot.
    const alpha = registry.getAllChildren().find((c) => c.scope === "alpha")!;
    registry.updateStatus(alpha.sessionFile, "completed");
    assert.equal(occupied(), 1, "Pane-free does not mean owned-free");

    const duplicate = await h.spawn({ task: "unit one again", name: "alpha", delegationReason: reason });
    assert.equal(duplicate.details.error, "admission-refused");
    assert.match(String(duplicate.content?.[0]?.text), /already occupies a slot/);

    const noReason = await h.spawn({ task: "trivial", name: "jam" });
    assert.equal(noReason.details.error, "admission-refused");
    assert.equal(h.calls.start.length, 1, "refused spawns launched nothing");

    // Fill the cumulative budget with real (dispositioned) work.
    for (const name of ["beta", "gamma", "delta"]) {
      const started = await h.spawn({ task: `unit ${name}`, name, delegationReason: reason });
      assert.equal((started.details as any).status, "started", name);
      const row = registry.getAllChildren().find((c) => c.scope === name)!;
      registry.updateStatus(row.sessionFile, "completed");
      const judged = await h.accept({
        childId: row.id,
        disposition: "accepted",
        resultRevision: 1,
        summary: `verified ${name}'s output directly`,
        evidence: [`inspected the ${name} report artifact`],
        integration: "absorbed",
      });
      assert.ok(String(judged.content?.[0]?.text).length > 0, name);
    }
    const fifth = await h.spawn({ task: "unit five", name: "echo", delegationReason: reason });
    assert.equal(fifth.details.error, "admission-refused");
    assert.match(String(fifth.content?.[0]?.text), /\/agent batch/, "the escape hatch is user-owned");

    // Only the user resets the batch — and old obligations survive it.
    await h.batchReset();
    assert.equal(registry.getBatch("sess-owner").launches, 0);
    assert.equal(registry.getPendingResults("sess-owner").length, 1, "alpha is still owed a verdict");
    assert.equal(occupied(), 1);
    const afterReset = await h.spawn({ task: "unit five", name: "echo", delegationReason: reason });
    assert.equal((afterReset.details as any).status, "started", "a user reset lifts the launch budget, not the obligations");
  } finally {
    await h.cleanup();
  }
});
