import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import agentExtension, { registry, resetPollFingerprints } from "../../extensions/agent.ts";
import type { ScopedChild } from "../../lib/delegation/scope-registry.ts";

// Host config must not leak ceilings or role bindings into these tests.
process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "terminate-agent-config");
delete process.env.PI_SUBAGENT_MAX_CHILDREN;

function child(id: string, status: ScopedChild["status"], owner = "sess-owner"): ScopedChild {
  return {
    id,
    name: `Worker ${id}`,
    scope: `scope-${id}`,
    sessionFile: `/tmp/terminate-tests/${id}.jsonl`,
    status,
    laneFiles: ["src/unit-a/"],
    lastMilestoneFiles: [],
    updatedAt: "2026-01-01",
    accountability: {
      ownerSessionId: owner,
      batchId: `${owner}:1`,
      workUnitKey: `unit-${id}`,
      delegationReason: "independent lane work",
      reviewPlan: "inspect the diff and run the tests",
      resultRevision: 0,
      disposition: status === "completed" ? "pending" : "pending",
      reviews: [],
      attempts: [],
    },
  };
}

function harness() {
  const tools = new Map<string, any>();
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
  agentExtension(pi, {
    client: {
      paneGet: async () => ({ pane_id: "w9:p1" }),
      paneRead: async () => "prompt$ ",
      paneList: async () => [],
      paneSendKeys: async () => {},
      paneClose: async () => {},
      paneStart: async () => ({ paneId: "w7:p1" }),
    } as any,
    stream: { watch: () => () => {}, onReconcile: () => () => {} },
  } as any);
  const ctx: any = {
    mode: "rpc",
    cwd: tmpdir(),
    ui: { notify() {} },
    sessionManager: {
      getSessionFile: () => "/tmp/terminate-tests/parent.jsonl",
      getSessionId: () => "sess-owner",
      getSessionDir: () => "/tmp/terminate-tests/sessions",
    },
  };
  // A successful spawn arms a watcher (fs handle + poll interval) that keeps the
  // process alive; `session_shutdown` is the path a real shutdown takes, so tests
  // that spawn must emit it before finishing.
  const emit = async (name: string): Promise<void> => {
    for (const fn of hooks.get(name) ?? []) await fn({}, ctx);
  };
  return { tools, ctx, emit };
}

test("a repeated poll with nothing actionable ENDS the run instead of asking in prose", async () => {
  registry.resetForTests();
  resetPollFingerprints();
  const { tools, ctx } = harness();
  registry.registerChild(child("term-1", "running"));

  const first = await tools.get("agent_running").execute("t1", {}, undefined, undefined, ctx);
  assert.notEqual(first.terminate, true, "the first poll still reports the page and keeps the turn");

  const second = await tools.get("agent_running").execute("t2", {}, undefined, undefined, ctx);
  assert.equal(second.terminate, true, "the same answer twice is polling a push channel");
  assert.match(second.content[0].text, /No new events/);
  assert.match(second.content[0].text, /this run ends here/);

  registry.resetForTests();
  resetPollFingerprints();
});

test("an undispositioned result keeps the turn: terminating would strand the review duty", async () => {
  registry.resetForTests();
  resetPollFingerprints();
  const { tools, ctx } = harness();
  registry.registerChild(child("term-2", "completed"));

  await tools.get("agent_running").execute("t1", {}, undefined, undefined, ctx);
  const repeat = await tools.get("agent_running").execute("t2", {}, undefined, undefined, ctx);
  assert.match(repeat.content[0].text, /No new events/);
  assert.notEqual(repeat.terminate, true, "the parent still owes agent_accept_result");

  registry.resetForTests();
  resetPollFingerprints();
});

test("a successful spawn ENDS the run; lanes run in parallel when spawned in one batch", async () => {
  registry.resetForTests();
  resetPollFingerprints();
  const dir = await mkdtemp(join(tmpdir(), "terminate-spawn-"));
  const { tools, ctx, emit } = harness();
  ctx.cwd = dir;
  const spawn = tools.get("agent_spawn");

  try {
    const first = await spawn.execute("t1", {
      name: "tidy",
      task: "tidy one import in src/unit-a/queue.ts",
      delegationReason: "independent lane work in a separate file",
      laneFiles: ["src/unit-a/queue.ts"],
      acceptanceCriteria: ["the import is removed and the file still typechecks"],
    }, undefined, undefined, ctx);

    assert.equal(first.details?.status, "started", first.content?.[0]?.text);
    // The parent generates nothing while children work. pi skips the follow-up
    // model call only when every result in the batch terminates, so parallel
    // lanes are spawned together in ONE assistant message.
    assert.equal(first.terminate, true, "a successful spawn must end the run");
    assert.match(first.content[0].text, /Do not poll or sleep/);

    const second = await spawn.execute("t2", {
      moreSpawns: false,
      name: "split",
      task: "split one helper in src/unit-b/page.ts",
      delegationReason: "a second independent lane in another directory",
      laneFiles: ["src/unit-b/page.ts"],
      acceptanceCriteria: ["the helper is split and the file still typechecks"],
    }, undefined, undefined, ctx);

    assert.equal(second.details?.status, "started", second.content?.[0]?.text);
    assert.equal(registry.getRunningChildren().length, 2, "both lanes run at once");

    // A parent that spawns one lane per turn opts out of the stop on all but the last.
    registry.resetForTests();
    const third = await spawn.execute("t3", {
      name: "third",
      task: "rename one helper in src/unit-c/x.ts",
      delegationReason: "a third independent lane in another directory",
      laneFiles: ["src/unit-c/x.ts"],
      acceptanceCriteria: ["the helper is renamed"],
      moreSpawns: true,
      budgetMinutes: 5,
    }, undefined, undefined, ctx);
    assert.equal(third.details?.status, "started", third.content?.[0]?.text);
    assert.notEqual(third.terminate, true, "moreSpawns keeps the run alive for the next lane");
  } finally {
    await emit("session_shutdown");
    registry.resetForTests();
    resetPollFingerprints();
  }
});

test("a batch spawn launches every lane in ONE call and then ends the run", async () => {
  registry.resetForTests();
  resetPollFingerprints();
  const dir = await mkdtemp(join(tmpdir(), "terminate-batch-"));
  const { tools, ctx, emit } = harness();
  ctx.cwd = dir;
  const spawn = tools.get("agent_spawn");
  try {
    const result = await spawn.execute("b1", {
      agents: [
        { name: "alpha", task: "summarise topic A", delegationReason: "independent research lane A", role: "planner" },
        { name: "beta", task: "summarise topic B", delegationReason: "independent research lane B", role: "planner" },
      ],
    }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /2 of 2 lane\(s\) started/, result.content[0].text);
    assert.equal(result.terminate, true, "everything started, nothing refused: the run ends");
    assert.equal(registry.getRunningChildren().length, 2, "both lanes run at once");

    // A third lane exceeds the 2-slot cap: it is refused, the parent keeps its turn.
    const over = await spawn.execute("b2", {
      agents: [{ name: "gamma", task: "summarise topic C", delegationReason: "a third lane over the cap", role: "planner" }],
    }, undefined, undefined, ctx);
    assert.match(over.content[0].text, /0 of 1 lane\(s\) started, 1 refused/);
    assert.notEqual(over.terminate, true, "a refused lane needs the parent's decision");

    const missing = await spawn.execute("b3", { agents: [{ name: "x", task: "", delegationReason: "" }] } as any, undefined, undefined, ctx);
    assert.match(missing.content[0].text, /REFUSED/);
  } finally {
    await emit("session_shutdown");
    registry.resetForTests();
    resetPollFingerprints();
  }
});
