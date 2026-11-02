import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import agentExtension, { registry } from "../../extensions/agent.ts";

// The launch planner creates its session directory under the agent dir, so point
// that at a temp root: a test must never write into a real ~/.pi/agent.
process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "rework-spawn-agent-config");
delete process.env.PI_SUBAGENT_MAX_CHILDREN;
delete process.env.PI_SUBAGENT_DEPTH;

const OWNER = "sess-owner";
const SOURCE_ID = "src-1";
const SOURCE_FILE = "/tmp/rework-spawn/src-1.jsonl";

function harness() {
  const tools = new Map<string, any>();
  const pi: any = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    on() {},
    appendEntry() {},
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...tools.keys()],
    setActiveTools() {},
    sendMessage() {},
    events: { on() {}, emit() {} },
  };
  const client: any = {
    paneGet: async (paneId: string) => ({ pane_id: paneId }),
    paneRead: async () => "working",
    paneList: async () => [],
    paneClose: async () => {},
    paneSendKeys: async () => {},
    paneStart: async () => ({ paneId: "pane-rework" }),
  };
  agentExtension(pi, {
    client,
    stream: { watch: () => () => {}, onReconcile: () => () => {} },
  });
  return tools;
}

function ctxFor(dir: string) {
  return {
    mode: "rpc",
    cwd: dir,
    hasUI: false,
    isIdle: () => true,
    sessionManager: {
      getSessionDir: () => join(dir, "sessions"),
      getSessionId: () => OWNER,
      getSessionFile: () => join(dir, "sessions", "parent.jsonl"),
      getBranch: () => [],
      getHeader: () => ({ id: OWNER }),
    },
    ui: { notify() {} },
  } as any;
}

/** A finished child whose result the parent sent back with a defect list. */
function seedChangesRequested(): void {
  registry.registerChild({
    id: SOURCE_ID,
    name: "Worker src-1",
    scope: "api",
    sessionFile: SOURCE_FILE,
    status: "running",
    handoffId: "handoff-api-1",
    handoffRevision: 1,
    frozenCriteria: ["retry budget is configurable", "existing tests pass"],
    laneFiles: ["src/api.ts"],
    lastMilestoneFiles: [],
    task: "add the retry budget to the client",
    updatedAt: "2026-01-01",
    accountability: {
      ownerSessionId: OWNER,
      batchId: `${OWNER}:1`,
      workUnitKey: "api",
      delegationReason: "independent lane",
      reviewPlan: "inspect the diff",
      resultRevision: 0,
      disposition: "pending",
      reviews: [],
      attempts: [],
      reworkRound: 0,
    },
  });
  registry.updateStatus(SOURCE_FILE, "completed");
  registry.recordDisposition(OWNER, SOURCE_ID, {
    disposition: "changes-requested",
    resultRevision: 1,
    summary: "criterion 1 unmet",
    evidence: [],
    integration: "rework the same unit",
    defects: ["Criterion 'retry budget is configurable' is unmet: it is a constant in src/api.ts:12."],
  });
}

test("a rework is admitted, inherits its unit and hands the slot over", async () => {
  registry.resetForTests();
  const dir = await mkdtemp(join(tmpdir(), "pi-rework-spawn-"));
  await mkdir(join(dir, "sessions"), { recursive: true });
  try {
    seedChangesRequested();
    assert.equal(registry.getOccupiedChildren(OWNER).length, 1, "the changes-requested row holds the unit");

    const tools = harness();
    const spawn = tools.get("agent_spawn");
    // Deliberately different wording: if the scope were recomputed from the new
    // task, the rework would become a different unit with different ids.
    const result = await spawn.execute(
      "t",
      {
        task: "fix the constant in src/api.ts",
        delegationReason: "continue the same unit",
        reworkOf: SOURCE_ID,
      },
      undefined,
      undefined,
      ctxFor(dir),
    );

    const body = String(result.content?.[0]?.text ?? "");
    assert.doesNotMatch(body, /^Refused:/, `a rework must be admitted, got: ${body}`);
    assert.equal(result.details.status, "started");

    const row = registry.getChildById(result.details.id)!;
    assert.equal(row.scope, "api", "the rework keeps the unit's scope");
    assert.equal(row.accountability!.workUnitKey, "api", "and its work-unit key");
    assert.deepEqual(row.laneFiles, ["src/api.ts"], "the lane is inherited, not lost");
    assert.deepEqual(row.frozenCriteria, ["retry budget is configurable", "existing tests pass"],
      "the criteria being fixed are the ORIGINAL ones");
    assert.equal(row.accountability!.reworkRound, 1, "the round counter advances on the successor");
    assert.equal(row.handoffId, "handoff-api-2", "the rework authors the next handoff round");

    // The source is handed over: it keeps its audit trail, not its slot.
    const source = registry.getChildById(SOURCE_ID)!;
    assert.equal(source.supersededBy, row.id);
    assert.equal(source.accountability!.disposition, "changes-requested", "the verdict stays as history");
    assert.equal(source.accountability!.reviews.at(-1)!.defects!.length, 1);

    const occupied = registry.getOccupiedChildren(OWNER);
    assert.equal(occupied.length, 1, "one unit holds one slot, not two");
    assert.equal(occupied[0]!.id, row.id);
    assert.equal(registry.getBatch(OWNER).launches, 0, "a continuation is not charged to the batch budget");

    // The handoff the child will read carries the defects and cites the original.
    const sidecar = `${row.sessionFile}.artifact.handoff-api-2.json`;
    const artifact = JSON.parse(await readFile(sidecar, "utf8"));
    assert.equal(artifact.scope, "api");
    assert.match(artifact.content, /handoff-api-1/, "the original handoff is named");
    assert.match(artifact.content, /it is a constant in src\/api\.ts:12/, "the defect is restated");
    assert.match(artifact.content, /retry budget is configurable/, "the contract is the original criteria");
  } finally {
    registry.resetForTests();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a rework cannot re-open a source that was already handed over", async () => {
  registry.resetForTests();
  const dir = await mkdtemp(join(tmpdir(), "pi-rework-chain-"));
  await mkdir(join(dir, "sessions"), { recursive: true });
  try {
    seedChangesRequested();
    const tools = harness();
    const spawn = tools.get("agent_spawn");
    const first = await spawn.execute(
      "t",
      { task: "fix it", delegationReason: "continue", reworkOf: SOURCE_ID },
      undefined, undefined, ctxFor(dir),
    );
    assert.equal(first.details.status, "started");

    // Naming the original again used to reset the round count to 0 and bypass the
    // cap. The chain is linear now, so the earlier attempt is refused.
    const again = await spawn.execute(
      "t",
      { task: "fix it again", delegationReason: "continue", reworkOf: SOURCE_ID },
      undefined, undefined, ctxFor(dir),
    );
    assert.equal(again.details.error, "rework-superseded");
    assert.match(String(again.content?.[0]?.text), /already handed to/);
    assert.equal(registry.getOccupiedChildren(OWNER).length, 1, "a refused rework writes nothing");
  } finally {
    registry.resetForTests();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a rework requires a recorded change request and a defect list", async () => {
  registry.resetForTests();
  const dir = await mkdtemp(join(tmpdir(), "pi-rework-gate-"));
  await mkdir(join(dir, "sessions"), { recursive: true });
  try {
    const tools = harness();
    const spawn = tools.get("agent_spawn");

    // Still pending: nothing was sent back, so there is nothing to rework.
    seedChangesRequested();
    registry.recordDisposition(OWNER, SOURCE_ID, {
      disposition: "accepted",
      resultRevision: 1,
      summary: "verified",
      evidence: ["ran npm test"],
      integration: "merged",
    });
    const accepted = await spawn.execute(
      "t",
      { task: "fix it", delegationReason: "continue", reworkOf: SOURCE_ID },
      undefined, undefined, ctxFor(dir),
    );
    assert.equal(accepted.details.error, "rework-not-requested");
    assert.equal(registry.getOccupiedChildren(OWNER).length, 0, "nothing written by the refusal");
  } finally {
    registry.resetForTests();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the round cap stops at two reworks of one unit", async () => {
  registry.resetForTests();
  const dir = await mkdtemp(join(tmpdir(), "pi-rework-cap-"));
  await mkdir(join(dir, "sessions"), { recursive: true });
  try {
    seedChangesRequested();
    const tools = harness();
    const spawn = tools.get("agent_spawn");
    const ctx = ctxFor(dir);

    // Round 1: the original is handed over to the first rework.
    const first = await spawn.execute("t",
      { task: "fix it", delegationReason: "continue", reworkOf: SOURCE_ID }, undefined, undefined, ctx);
    assert.equal(first.details.status, "started", String(first.content?.[0]?.text));
    const round1 = registry.getChildById(first.details.id)!;
    registry.updateStatus(round1.sessionFile, "completed");
    registry.recordDisposition(OWNER, round1.id, {
      disposition: "changes-requested",
      resultRevision: 1,
      summary: "still unmet",
      evidence: [],
      integration: "rework",
      defects: ["still a constant"],
    });

    // Round 2 is the last one the unit may spend.
    const second = await spawn.execute("t",
      { task: "fix it", delegationReason: "continue", reworkOf: round1.id }, undefined, undefined, ctx);
    assert.equal(second.details.status, "started", String(second.content?.[0]?.text));
    const round2 = registry.getChildById(second.details.id)!;
    assert.equal(round2.accountability!.reworkRound, 2);
    registry.updateStatus(round2.sessionFile, "completed");
    registry.recordDisposition(OWNER, round2.id, {
      disposition: "changes-requested",
      resultRevision: 1,
      summary: "still unmet",
      evidence: [],
      integration: "rework",
      defects: ["still a constant"],
    });

    const third = await spawn.execute("t",
      { task: "fix it", delegationReason: "continue", reworkOf: round2.id }, undefined, undefined, ctx);
    assert.equal(third.details.error, "rework-rounds-exhausted");
    assert.match(String(third.content?.[0]?.text), /already been reworked 2 time/);
  } finally {
    registry.resetForTests();
    await rm(dir, { recursive: true, force: true });
  }
});
