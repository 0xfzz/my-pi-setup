/**
 * The chunked spec-review flow, end to end at the tool boundary.
 *
 * This is the flow the orchestrator is supposed to run:
 *
 *   N handoffs → K chunks → one reviewer per chunk → fix a member → spawn it
 *
 * The regression it replaces: a batch of handoffs launched ONE reviewer for the
 * whole split, and a fix could never make a run ready, so every revision opened
 * another reviewer child.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import subagentV2, { chunkRuns, handoffs, registry } from "../../extensions/orchestrator.ts";
import { ARTIFACT_TYPE } from "../../lib/artifact-state.ts";

interface Harness {
  dir: string;
  ctx: any;
  started: any[];
  launchScripts: () => Promise<string[]>;
  tickets: () => Promise<string[]>;
  call: (name: string, params: any) => Promise<any>;
  artifact: (id: string) => string | undefined;
  detach: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "spec-wave-"));
  const tools = new Map<string, any>();
  const started: any[] = [];
  const branch: any[] = [];
  const hooks = new Map<string, Function[]>();
  const client: any = {
    async paneStart(p: any) {
      started.push(p);
      return { paneId: `pane-${started.length}` };
    },
    async paneGet(paneId: string) { return { pane_id: paneId }; },
    async paneRead() { return null; },
    async paneList() { return []; },
    async paneClose() {},
    async paneSendKeys() {},
    async paneSendText() {},
  };
  const pi: any = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    on(name: string, fn: Function) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
    getAllTools() { return [...tools.values()]; },
    appendEntry() {},
    sendMessage() {},
  };
  const ctx: any = {
    cwd: dir,
    mode: "tui",
    sessionManager: {
      getSessionId: () => "parent-session",
      getSessionFile: () => join(dir, "parent-session.jsonl"),
      getSessionDir: () => dir,
      getBranch: () => branch,
    },
    ui: { notify() {}, async input() { return ""; }, async select() { return ""; }, async confirm() { return false; } },
    modelRegistry: { getAll: () => [], find: (provider: string, model: string) => ({ provider, id: model }), hasConfiguredAuth: () => true },
    async executeTool(name: string, args: any) {
      if (name !== "artifact_save") return { isError: true, result: { content: [{ type: "text", text: `unknown tool ${name}` }] } };
      const previous = [...branch].reverse().find((entry) => entry?.customType === ARTIFACT_TYPE && entry.data?.id === args.id);
      branch.push({
        type: "custom",
        customType: ARTIFACT_TYPE,
        data: {
          id: args.id,
          title: args.title,
          type: args.type,
          content: args.content,
          createdBy: "main",
          tags: [],
          version: (previous?.data?.version ?? 0) + 1,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date().toISOString(),
          ...(args.scope ? { scope: args.scope } : {}),
        },
      });
      return { isError: false, result: { content: [{ type: "text", text: `saved ${args.id}` }] } };
    },
  };
  subagentV2(pi, { client, stream: { watch: () => () => {}, onReconcile: () => () => {} } });
  for (const start of hooks.get("session_start") ?? []) await start({}, ctx);
  return {
    dir,
    ctx,
    started,
    async launchScripts() {
      const out: string[] = [];
      for (const pane of started) if (pane?.launchScriptFile) out.push(await readFile(pane.launchScriptFile, "utf8"));
      return out;
    },
    async call(name: string, params: any) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} is registered`);
      return tool.execute("call-id", params, undefined, undefined, ctx);
    },
    /** The reviewer's ticket is a file the launch script passes with `@path`. */
    async tickets() {
      const out: string[] = [];
      for (const pane of started) {
        if (!pane?.launchScriptFile) continue;
        const script = await readFile(pane.launchScriptFile, "utf8");
        for (const match of script.matchAll(/'@([^']+)'/g)) out.push(await readFile(match[1]!, "utf8"));
      }
      return out;
    },
    artifact(id: string) {
      const found = [...branch].reverse().find((entry) => entry?.customType === ARTIFACT_TYPE && entry.data?.id === id);
      return found?.data?.content;
    },
    async detach() {
      for (const stop of hooks.get("session_shutdown") ?? []) await stop({}, ctx);
      for (const child of registry.getAllChildren()) registry.updateStatus(child.sessionFile, "closed");
      chunkRuns.clear();
      handoffs.clear();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const FIVE = [
  ["alpha", "Implement the alpha retry policy", "src/alpha.ts"],
  ["beta", "Implement the beta queue policy", "src/beta.ts"],
  ["gamma", "Implement the gamma cache policy", "src/gamma.ts"],
  ["delta", "Implement the delta route policy", "src/delta.ts"],
  ["epsilon", "Implement the epsilon auth policy", "src/epsilon.ts"],
] as const;

async function authorHandoffs(h: Harness, entries: readonly (readonly [string, string, string])[]) {
  for (const [scope, goal, lane] of entries) {
    const written = await h.call("orch_handoff", {
      scope,
      goal,
      acceptanceCriteria: [`${scope} behaves as specified`],
      laneFiles: [lane],
      verifyCommand: "npm run typecheck",
    });
    assert.ok(written.details?.id, `handoff ${scope}: ${written.content[0].text}`);
  }
}

const scopes = (n: number) => FIVE.slice(0, n).map(([scope]) => scope);

/** The report a chunk reviewer would have submitted. */
function fileReport(
  h: Harness,
  runId: string,
  chunkId: string,
  members: Array<{ memberId: string; findings?: any[]; coverage?: string[] }>,
) {
  const run = chunkRuns.get(runId);
  assert.ok(run, `run ${runId} exists`);
  const slot = run!.chunks.find((entry) => entry.chunkId === chunkId);
  assert.ok(slot, `chunk ${chunkId} exists`);
  const dir = join(h.dir, "artifacts", "parent-session", "spec-reviews", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${chunkId}.json`),
    JSON.stringify({
      version: 2,
      runId,
      chunkId,
      targetHash: slot!.targetHash,
      summary: `${chunkId} judged`,
      members: members.map((member) => ({
        memberId: member.memberId,
        verdict: (member.findings?.length ?? 0) > 0 ? "findings" : "clean",
        coverage: member.coverage ?? ["goal", "acceptance criteria", "lane"],
        findings: member.findings ?? [],
      })),
      submittedAt: new Date(0).toISOString(),
    }, null, 2),
  );
}

const finding = (memberId: string, overrides: Record<string, unknown> = {}) => ({
  id: `F-${memberId}-1`,
  severity: "major",
  location: "## Goal",
  discrepancy: "the goal states no retry bound",
  rationale: "a worker has to invent one",
  ...overrides,
});

test("plan shows the 2 + 3 split and launches nothing", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    await authorHandoffs(h, FIVE);
    const planned = await h.call("orch_spec_review", { action: "plan", handoffIds: scopes(5) });
    assert.deepEqual(planned.details.chunks, [
      { chunkId: "review-1", scopes: ["alpha", "beta"], reviewers: 1 },
      { chunkId: "review-2", scopes: ["delta", "epsilon", "gamma"], reviewers: 1 },
    ], planned.content[0].text);
    assert.equal(h.started.length, 0, "plan never opens a pane");
  } finally {
    await h.detach();
  }
});

test("start launches ONE reviewer per chunk, each scoped to its own members", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    await authorHandoffs(h, FIVE);
    const started = await h.call("orch_spec_review", { action: "start", handoffIds: scopes(5) });
    assert.ok(started.details.runId, started.content[0].text);
    assert.equal(h.started.length, 2, "five specs became two reviewers, not one and not five");
    assert.deepEqual(started.details.launched, ["review-1", "review-2"]);

    const tickets = await h.tickets();
    assert.equal(tickets.length, 2);
    const first = tickets.find((ticket) => ticket.includes("review-1 judges")) ?? "";
    const second = tickets.find((ticket) => ticket.includes("review-2 judges")) ?? "";
    assert.match(first, /review-1 judges: alpha, beta/);
    assert.match(second, /review-2 judges: delta, epsilon, gamma/);
    assert.doesNotMatch(first, /gamma|delta|epsilon/, "a reviewer never sees a sibling chunk's specs");
    assert.doesNotMatch(second, /alpha|beta/);
    // The report shape is per member, which is what makes skipping a member fail.
    assert.match(first, /"version": 2/);
    assert.match(first, /every member listed above appears exactly once/);

    const run = chunkRuns.get(started.details.runId)!;
    assert.ok(run.chunks.every((slot) => slot.status === "running"));
    assert.equal(run.members.length, 5);
  } finally {
    await h.detach();
  }
});

test("a report that skips a member is incomplete; a complete one makes every member ready", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    await authorHandoffs(h, FIVE);
    const started = await h.call("orch_spec_review", { action: "start", handoffIds: scopes(5) });
    const runId = started.details.runId;

    fileReport(h, runId, "review-1", [{ memberId: "alpha" }]);
    const incomplete = await h.call("orch_spec_review", { action: "collect", runId });
    assert.match(incomplete.content[0].text, /no block for member "beta"/i, incomplete.content[0].text);

    fileReport(h, runId, "review-1", [{ memberId: "alpha" }, { memberId: "beta" }]);
    fileReport(h, runId, "review-2", [{ memberId: "gamma" }, { memberId: "delta" }, { memberId: "epsilon" }]);
    const collected = await h.call("orch_spec_review", { action: "collect", runId });
    assert.equal(collected.details.ready.length, 5, collected.content[0].text);
    assert.match(collected.content[0].text, /EVERY MEMBER READY/);

    // Each ready handoff is bound, so spawn has a revision to check.
    for (const scope of scopes(5)) {
      const stored = [...handoffs.values()].find((entry) => entry.record.scope === scope)!;
      assert.ok(stored.record.designRef, `${scope} must be bound after a clean chunk review`);
      assert.equal(stored.record.designRef!.runId, runId);
      assert.equal(stored.record.designRef!.memberId, scope);
    }
  } finally {
    await h.detach();
  }
});

test("a prose fix keeps the approval: the member becomes spawnable with no re-review", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    await authorHandoffs(h, FIVE);
    const started = await h.call("orch_spec_review", { action: "start", handoffIds: scopes(5) });
    const runId = started.details.runId;
    fileReport(h, runId, "review-1", [{ memberId: "alpha", findings: [finding("alpha")] }, { memberId: "beta" }]);
    fileReport(h, runId, "review-2", [{ memberId: "gamma" }, { memberId: "delta" }, { memberId: "epsilon" }]);
    await h.call("orch_spec_review", { action: "collect", runId });
    assert.equal(chunkRuns.get(runId)!.members.find((m) => m.scope === "alpha")!.currentHash.length, 64);

    const artifactId = chunkRuns.get(runId)!.members.find((m) => m.scope === "alpha")!.artifactId;
    const before = h.artifact(artifactId) ?? "";

    const fixed = await h.call("orch_spec_review", {
      action: "fix",
      runId,
      findingId: "F-alpha-1",
      memberId: "alpha",
      patch: {
        oldText: "Implement the alpha retry policy",
        newText: "Implement the alpha retry policy with a 3-attempt bound",
      },
      rationale: "stated the retry bound the reviewer asked for",
    });
    assert.equal(fixed.details.ready, true, fixed.content[0].text);
    assert.equal(fixed.details.revision, 2);
    assert.notEqual(fixed.details.beforeHash, fixed.details.afterHash);

    // The worker-readable artifact carries the fix; the wave did not re-review it.
    const after = h.artifact(artifactId) ?? "";
    assert.match(after, /3-attempt bound/);
    assert.notEqual(after, before);
    assert.equal(h.started.length, 2, "applying a fix must not launch another reviewer");

    const stored = [...handoffs.values()].find((entry) => entry.record.scope === "alpha")!;
    assert.equal(stored.record.designRef!.targetHash, fixed.details.afterHash, "the designRef moves to the revised revision");

    const spawned = await h.call("orch_spawn", { name: "AlphaWorker", task: "Implement it.", handoffId: stored.record.id });
    assert.equal(spawned.details.status, "started", spawned.content[0].text);
  } finally {
    await h.detach();
  }
});

test("a fix that changes the lane is refused before any write", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    await authorHandoffs(h, FIVE);
    const started = await h.call("orch_spec_review", { action: "start", handoffIds: scopes(5) });
    const runId = started.details.runId;
    fileReport(h, runId, "review-1", [{ memberId: "alpha", findings: [finding("alpha")] }, { memberId: "beta" }]);
    fileReport(h, runId, "review-2", [{ memberId: "gamma" }, { memberId: "delta" }, { memberId: "epsilon" }]);
    await h.call("orch_spec_review", { action: "collect", runId });

    const member = chunkRuns.get(runId)!.members.find((entry) => entry.scope === "alpha")!;
    const before = h.artifact(member.artifactId) ?? "";
    const refused = await h.call("orch_spec_review", {
      action: "fix",
      runId,
      findingId: "F-alpha-1",
      memberId: "alpha",
      patch: { oldText: "- `src/alpha.ts`", newText: "- `src/alpha.ts`\n- `src/beta.ts`" },
      rationale: "widen the lane",
    });
    assert.equal(refused.details.error, "structural-change-needs-reauthor", refused.content[0].text);
    assert.match(refused.content[0].text, /lane files/);
    assert.equal(h.artifact(member.artifactId), before, "no partial write on refusal");
    assert.equal(chunkRuns.get(runId)!.members.find((entry) => entry.scope === "alpha")!.revision, 1);
  } finally {
    await h.detach();
  }
});

test("a wave already under review is reused, never re-launched", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    await authorHandoffs(h, FIVE);
    const first = await h.call("orch_spec_review", { action: "start", handoffIds: scopes(5) });
    const again = await h.call("orch_spec_review", { action: "start", handoffIds: scopes(5) });
    assert.equal(again.details.reused, true, again.content[0].text);
    assert.equal(again.details.runId, first.details.runId);
    assert.deepEqual(again.details.launched, []);
    assert.equal(h.started.length, 2, "one review per wave");
  } finally {
    await h.detach();
  }
});

test("the whole flow: 5 specs → 2 reviewers → fix 2 members → spawn 5 → QA in 2 groups", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    await authorHandoffs(h, FIVE);

    // 1. The split is decided before any pane opens.
    const planned = await h.call("orch_spec_review", { action: "plan", handoffIds: scopes(5) });
    assert.equal(planned.details.reviewers, 2);
    assert.equal(h.started.length, 0);

    // 2. One reviewer per chunk.
    const started = await h.call("orch_spec_review", { action: "start", handoffIds: scopes(5) });
    const runId = started.details.runId;
    assert.equal(h.started.length, 2);

    // 3. Two specs have a finding; both chunks are otherwise clean.
    fileReport(h, runId, "review-1", [
      { memberId: "alpha", findings: [finding("alpha")] },
      { memberId: "beta" },
    ]);
    fileReport(h, runId, "review-2", [
      { memberId: "delta", findings: [finding("delta")] },
      { memberId: "epsilon" },
      { memberId: "gamma" },
    ]);
    const collected = await h.call("orch_spec_review", { action: "collect", runId });
    assert.deepEqual(collected.details.ready.sort(), ["beta", "epsilon", "gamma"]);

    // 4. The orchestrator fixes each finding itself, and the wave stays spawnable.
    for (const scope of ["alpha", "delta"]) {
      const fixed = await h.call("orch_spec_review", {
        action: "fix",
        runId,
        findingId: `F-${scope}-1`,
        memberId: scope,
        patch: {
          oldText: `Implement the ${scope} retry policy`.replace("retry", scope === "delta" ? "route" : "retry"),
          newText: `Implement the ${scope} policy with a 3-attempt bound`,
        },
        rationale: "stated the bound",
      });
      assert.equal(fixed.details.ready, true, fixed.content[0].text);
    }
    assert.equal(h.started.length, 2, "fixes never launch a reviewer");

    // 5. Every member spawns against the reviewed revision.
    const handoffIds = [...handoffs.values()].map((entry) => entry.record.id);
    for (const [index, handoffId] of handoffIds.entries()) {
      const spawned = await h.call("orch_spawn", { name: `Worker${index}`, task: "Implement it.", handoffId });
      assert.equal(spawned.details.status, "started", spawned.content[0].text);
    }
    assert.equal(h.started.length, 7, "5 workers after 2 reviewers");

    // 6. QA fans the finished wave out in 2 + 3, unchanged from before the rewrite.
    for (const child of registry.getAllChildren()) registry.updateStatus(child.sessionFile, "completed");
    const qa = await h.call("orch_qa", { scopes: scopes(5) });
    assert.equal(qa.details.groups.length, 2, qa.content[0].text);
    assert.deepEqual(qa.details.groups.map((group: any) => group.scopes), [
      ["alpha", "beta"],
      ["gamma", "delta", "epsilon"],
    ]);
    assert.equal(h.started.length, 9, "2 QA reviewers open after the 5 workers");
  } finally {
    await h.detach();
  }
});

test("a legacy preset argument cannot bring the lens panel back", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    await authorHandoffs(h, FIVE);
    // An old prompt (or an old saved call) may still pass `preset`. It is ignored:
    // the wave is chunked, not panel-reviewed, so five specs stay two reviewers.
    const started = await h.call("orch_spec_review", {
      action: "start",
      handoffIds: scopes(5),
      preset: "architecture",
    });
    assert.equal(h.started.length, 2, "one reviewer per chunk, never a lens panel");
    assert.deepEqual(started.details.launched, ["review-1", "review-2"]);
    const run = chunkRuns.get(started.details.runId)!;
    assert.equal(run.members.length, 5);
    assert.ok(run.chunks.every((slot) => slot.status === "running"));
  } finally {
    await h.detach();
  }
});
