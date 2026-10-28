/**
 * The batch review lifecycle, end to end at the tool boundary.
 *
 * Regression for the loop that shipped: a fix could never make a run ready, so
 * every revision opened another reviewer child. Here one reviewer judges the
 * whole split, its findings carry exact patches, and applying them is the fix —
 * with no second reading and no second child.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import subagentV2, { handoffs, registry, specReviews } from "../../extensions/orchestrator.ts";
import { ARTIFACT_TYPE } from "../../lib/artifact-state.ts";
import { designRefProblem, effectiveReviewTarget } from "../../lib/orchestrator/spec-review.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "spec-batch-"));
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
    // The adapter arms its watchdog from session_start; keeping the handlers lets
    // detach() run session_shutdown and leave no interval holding the process.
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
      specReviews.clear();
      handoffs.clear();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function authorTwoHandoffs(h: Harness) {
  for (const [scope, goal, lane] of [
    ["alpha", "Implement the alpha retry policy", "src/alpha.ts"],
    ["beta", "Implement the beta queue policy", "src/beta.ts"],
  ] as const) {
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

/** The report a reviewer would have submitted: one finding, one exact patch. */
function fileReport(runId: string, findings: any[]) {
  const run = specReviews.get(runId)!;
  run.reports = {
    gate: {
      runId,
      lens: "gate",
      targetHash: run.target.contentHash,
      summary: "two handoffs judged against the PRD",
      findings,
      verdict: "findings",
      submittedAt: new Date(0).toISOString(),
    },
  } as any;
  run.reviewers[0]!.status = "submitted";
  return run;
}

const member = (runId: string, id: string) => specReviews.get(runId)!.members!.find((m) => m.id === id)!;

function finding(overrides: Record<string, unknown>) {
  return {
    id: "F-gate-1",
    lens: "gate",
    severity: "major",
    location: "alpha · Goal",
    discrepancy: "the goal does not state a retry bound",
    rationale: "a worker must invent one",
    ...overrides,
  };
}

test("one reviewer judges the whole split, and its patches are the fix", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    await authorTwoHandoffs(h);
    const started = await h.call("orch_spec_review", { action: "start", handoffIds: ["alpha", "beta"] });
    assert.ok(started.details.runId, started.content[0].text);
    assert.equal(h.started.length, 1, "a batch of two handoffs launches ONE reviewer, not one per unit");
    assert.deepEqual(started.details.members.map((m: any) => m.memberId), ["alpha", "beta"]);

    const scripts = await h.launchScripts();
    assert.equal(scripts.length, 1);
    const tickets = (await h.tickets()).join("\n");
    assert.match(tickets, /Batch instructions/i, "the ticket tells the reviewer it judges a batch");
    assert.match(tickets, /alpha/);
    assert.match(tickets, /beta/);

    const runId = started.details.runId;
    const before = effectiveReviewTarget(specReviews.get(runId)!, "alpha").snapshot;
    fileReport(runId, [finding({
      memberId: "alpha",
      patch: { oldText: "Implement the alpha retry policy", newText: "Implement the alpha retry policy with a 3-attempt bound" },
    })]);

    const resolved = await h.call("orch_spec_review", { action: "resolve", runId });
    assert.equal(resolved.details.resolution, "reviewer-patched", resolved.content[0].text);
    assert.equal(resolved.details.ready, true, resolved.content[0].text);
    assert.equal(h.started.length, 1, "applying the fix must not launch a second reviewer");

    // The pin stays immutable (reports are bound to it); the effective revision
    // carries the reviewer's patch, and the gate replays the chain to prove it.
    const after = effectiveReviewTarget(specReviews.get(runId)!, "alpha").snapshot;
    assert.notEqual(after, before, "the effective member revision is the amended text");
    assert.equal(member(runId, "alpha").target.snapshot, before, "the original pin is never rewritten");
    const artifact = h.artifact(member(runId, "alpha").target.ref!) ?? "";
    assert.match(artifact, /3-attempt bound/, "the worker-readable artifact carries the fix");
    assert.doesNotMatch(artifact, /## Goal\nImplement the alpha retry policy\n/, "the pre-patch goal is gone");

    // The handoff is bound to the amended, reviewed revision, so spawn is allowed.
    const stored = [...handoffs.values()].find((entry) => entry.record.scope === "alpha")!;
    assert.ok(stored.record.designRef, "the reviewed handoff is bound after the batch resolves");
    const problem = designRefProblem(stored.record.designRef, (id) => specReviews.get(id), h.artifact(stored.record.artifactId) ?? null);
    assert.equal(problem, undefined, `a patched, reviewed handoff must be spawnable: ${problem}`);
  } finally {
    await h.detach();
  }
});

test("a re-review of the same approved revision is refused, not re-run", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    await authorTwoHandoffs(h);
    const started = await h.call("orch_spec_review", { action: "start", handoffIds: ["alpha", "beta"] });
    const runId = started.details.runId;
    fileReport(runId, [finding({ verdict: undefined })]);
    await h.call("orch_spec_review", { action: "resolve", runId, dispositions: [
      { findingId: "F-gate-1", action: "accepted", rationale: "the bound is a worker decision, documented in guidance" },
    ] });
    assert.equal(specReviews.get(runId)!.readiness.ready, true);

    const again = await h.call("orch_spec_review", { action: "start", handoffIds: ["alpha", "beta"] });
    assert.equal(again.details.reused, true, again.content[0].text);
    assert.deepEqual(again.details.launched, []);
    assert.equal(h.started.length, 1, "an approved revision is never reviewed twice");
  } finally {
    await h.detach();
  }
});

test("patches that cross the structural boundary are refused before any write", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    await authorTwoHandoffs(h);
    const started = await h.call("orch_spec_review", { action: "start", handoffIds: ["alpha", "beta"] });
    const runId = started.details.runId;
    const original = h.artifact(member(runId, "alpha").target.ref!);

    fileReport(runId, [finding({
      memberId: "alpha",
      patch: { oldText: "- `src/alpha.ts`", newText: "- `src/alpha.ts`\n- `src/beta.ts`" },
    })]);
    const refused = await h.call("orch_spec_review", { action: "resolve", runId });
    assert.equal(refused.details.error, "invalid-review-patches", refused.content[0].text);
    assert.match(refused.content[0].text, /structural/i);
    assert.equal(h.artifact(member(runId, "alpha").target.ref!), original, "no partial write on refusal");
  } finally {
    await h.detach();
  }
});

test("an ambiguous or unknown-member patch is refused rather than guessed", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    await authorTwoHandoffs(h);
    const started = await h.call("orch_spec_review", { action: "start", handoffIds: ["alpha", "beta"] });
    const runId = started.details.runId;

    fileReport(runId, [finding({ memberId: "alpha", patch: { oldText: "the ", newText: "a " } })]);
    const ambiguous = await h.call("orch_spec_review", { action: "resolve", runId });
    assert.equal(ambiguous.details.error, "invalid-review-patches", ambiguous.content[0].text);
    assert.match(ambiguous.content[0].text, /exactly once/);

    fileReport(runId, [finding({ memberId: "gamma", patch: { oldText: "Implement the alpha retry policy", newText: "x" } })]);
    const unknown = await h.call("orch_spec_review", { action: "resolve", runId });
    assert.equal(unknown.details.error, "invalid-review-patches", unknown.content[0].text);
    assert.match(unknown.content[0].text, /Unknown batch member/);
  } finally {
    await h.detach();
  }
});

test("a batch over the cap, or with overlapping lanes, is refused before a reviewer exists", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    await authorTwoHandoffs(h);
    const overlapping = await h.call("orch_handoff", {
      scope: "gamma",
      goal: "Implement the gamma policy",
      acceptanceCriteria: ["gamma behaves as specified"],
      laneFiles: ["src/alpha.ts"],
    });
    assert.ok(overlapping.details?.id, overlapping.content[0].text);
    const refused = await h.call("orch_spec_review", { action: "start", handoffIds: ["alpha", "gamma"] });
    assert.equal(refused.details.error, "batch-lane-conflict", refused.content[0].text);
    assert.equal(h.started.length, 0);

    const tooMany = await h.call("orch_spec_review", {
      action: "start",
      handoffIds: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"],
    } as any);
    // The schema caps the list at five; a direct call must still be refused, not truncated.
    assert.ok(tooMany.details?.error, tooMany.content[0].text);
    assert.equal(h.started.length, 0);
  } finally {
    await h.detach();
  }
});
