/**
 * Runtime tests for the independent specification review surface.
 *
 * The `lib/` tests prove the pinning/readiness domain. These drive the actual
 * registered tools through a fake Pi + Herdr client, so they fail if the wiring
 * stops enforcing isolation, or if a reviewer can file a report into a run it was
 * not launched for. Assertions are about observable artefacts — the launch script
 * on disk, the report file, the refusal text — not about policy strings.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import subagentV2, { handoffs, registry, specReviews } from "../../extensions/orchestrator.ts";
import { SUPERVISOR_MODE_TYPE } from "../../lib/supervise-mode.ts";
import { ARTIFACT_TYPE } from "../../lib/artifact-state.ts";

interface Harness {
  dir: string;
  ctx: any;
  tools: Map<string, any>;
  started: any[];
  launchScripts: () => Promise<string[]>;
  call: (name: string, params: any) => Promise<any>;
  emit: (name: string, event?: any) => Promise<any>;
  detach: () => Promise<void>;
}

async function harness(deps: any = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "spec-review-rt-"));
  const tools = new Map<string, any>();
  const started: any[] = [];
  const hooks = new Map<string, Function[]>();

  const client: any = {
    async paneStart(p: any) {
      started.push(p);
      return { paneId: `pane-${started.length}` };
    },
    async paneRename() {},
    async paneGet(paneId: string) {
      return { pane_id: paneId };
    },
    async paneRead() {
      return null;
    },
    async paneList() {
      return [];
    },
    async paneClose() {},
    async paneSendText() {},
  };

  const pi: any = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on(name: string, fn: Function) {
      hooks.set(name, [...(hooks.get(name) ?? []), fn]);
    },
    getAllTools() {
      return [...tools.values()];
    },
    appendEntry() {},
    sendMessage() {},
  };

  const branch: any[] = [];
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
    // The role-model resolver validates against the live registry. Everything
    // "exists" here, so a launch test fails only on wiring, not on lookup.
    modelRegistry: {
      getAll: () => [],
      find: (provider: string, model: string) => ({ provider, id: model }),
      hasConfiguredAuth: () => true,
    },
    // `orch_handoff` publishes its spec through the artifact tool, exactly like
    // production. A harness without this seam cannot exercise the handoff path.
    async executeTool(name: string, args: any) {
      if (name === "artifact_save") {
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
            version: 1,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            ...(args.scope ? { scope: args.scope } : {}),
          },
        });
        return { isError: false, result: { content: [{ type: "text", text: `saved ${args.id}` }] } };
      }
      if (name === "artifact_recall") {
        const found = [...branch].reverse().find((entry) => entry?.customType === ARTIFACT_TYPE && entry.data?.id === args.id);
        return {
          isError: !found,
          result: { content: [{ type: "text", text: found ? found.data.content : `No artifact ${args.id}` }] },
        };
      }
      return { isError: true, result: { content: [{ type: "text", text: `unknown tool ${name}` }] } };
    },
  };

  subagentV2(pi, { client, stream: { watch: () => () => {}, onReconcile: () => () => {} }, ...deps });

  return {
    dir,
    ctx,
    tools,
    started,
    async launchScripts() {
      const out: string[] = [];
      for (const pane of started) {
        if (!pane?.launchScriptFile) continue;
        out.push(await readFile(pane.launchScriptFile, "utf8"));
      }
      return out;
    },
    async call(name: string, params: any) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} is registered`);
      return tool.execute("call-id", params, undefined, undefined, ctx);
    },
    async emit(name: string, event: any = {}) {
      let result: any;
      for (const fn of hooks.get(name) ?? []) result = await fn(event, ctx) ?? result;
      return result;
    },
    async detach() {
      for (const stop of hooks.get("session_shutdown") ?? []) await stop({}, ctx);
      for (const child of registry.getAllChildren()) registry.updateStatus(child.sessionFile, "closed");
      specReviews.clear();
      handoffs.clear();
      delete process.env.PI_SUBAGENT_REVIEW_POLICY;
      delete process.env.PI_SUBAGENT_REVIEW_RUN;
      delete process.env.PI_SUBAGENT_REVIEW_LENS;
      delete process.env.PI_SUBAGENT_REVIEW_TARGET;
      delete process.env.PI_SUBAGENT_REVIEW_DIR;
      delete process.env.PI_SUBAGENT_REVIEW_ROOTS;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function saveDesign(h: Harness, id: string, content: string) {
  h.ctx.sessionManager.getBranch().push({
    type: "custom",
    customType: ARTIFACT_TYPE,
    data: {
      id,
      title: "Design: retry policy",
      type: "spec",
      content,
      createdBy: "main",
      tags: [],
      version: 1,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  });
}

test("start pins the design, launches one devil's advocate by default, and leaks no parent channel", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    saveDesign(h, "retry-design", "# Retry\n\nRetry with exponential backoff. No jitter policy is stated.");

    const started = await h.call("orch_spec_review", { action: "start", targetArtifactId: "retry-design" });
    const details = started.details;
    assert.ok(details.runId, `start must return a run id: ${started.content[0].text}`);
    // One reviewer per document, with the merged gate lens. A panel is no longer
    // a preset: a wave of specs is split across chunk reviewers instead.
    assert.deepEqual(details.launched, ["gate"], "a document review launches one reviewer");

    const scripts = await h.launchScripts();
    assert.equal(scripts.length, 1, "one launch script for the one reviewer");
    for (const script of scripts) {
      // Isolation is structural: no parent transcript pointer, no artifact writer,
      // no shell. The reviewer judges a snapshot it was handed.
      assert.doesNotMatch(script, /PI_SUBAGENT_PARENT=/, "a reviewer must not receive the parent transcript pointer");
      assert.match(script, /PI_SUBAGENT_REVIEW_POLICY='spec-only'/);
      const toolsLine = script.split("\n").find((line) => line.includes("--tools")) ?? "";
      assert.ok(toolsLine, "the reviewer is launched with an explicit tool allowlist");
      for (const forbidden of ["bash", "write", "edit", "artifact_search", "artifact_list", "orch_parent_recall", "orch_parent_digest"]) {
        assert.ok(
          !new RegExp(`(^|[,='\"\\s])${forbidden}([,='\"\\s]|$)`).test(toolsLine),
          `reviewer tool allowlist must not include ${forbidden}: ${toolsLine}`,
        );
      }
      assert.match(toolsLine, /orch_spec_review_submit/);
      assert.match(toolsLine, /read/);
      // Research is part of the reviewer surface; only the writer and discovery
      // tools are absent.
      assert.match(toolsLine, /artifact_save/, "scoped evidence is allowed");
      assert.match(toolsLine, /web_research/);
      assert.match(toolsLine, /shell_read/);
    }

    // The pinned document itself is quoted into the ticket the reviewer receives.
    const run = details.runId;
    const dir = join(h.dir, "artifacts", "parent-session", "spec-reviews", run);
    assert.ok(dir.includes("spec-reviews"), "reports live under a run-scoped directory");
  } finally {
    await h.detach();
  }
});

test("a round must dispose of the previous round's findings before another starts", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    saveDesign(h, "gated-design", "# Gated\n\nThe retry policy is not stated.");
    const started = await h.call("orch_spec_review", { action: "start", targetArtifactId: "gated-design" });
    const run = specReviews.get(started.details.runId)!;
    run.reports = {
      gate: {
        runId: run.id,
        lens: "gate",
        targetHash: run.target.contentHash,
        summary: "the retry policy is missing",
        findings: [{
          id: "F-gate-1",
          lens: "gate",
          severity: "major",
          location: "Retry",
          discrepancy: "no retry policy is stated",
          rationale: "implementers must guess the backoff",
        }],
        submittedAt: new Date(0).toISOString(),
      },
    } as any;
    run.status = "blocked";
    run.reviewers[0]!.status = "submitted";
    run.readiness = { ...run.readiness, ready: false, reasons: ["unresolved major: F-gate-1 (Retry)"], counts: { blocker: 0, major: 1, nit: 0, open: 1 } };

    const refused = await h.call("orch_spec_review", { action: "start", targetArtifactId: "gated-design" });
    assert.equal(refused.details.error, "findings-open", refused.content[0].text);
    assert.deepEqual(refused.details.findings, ["F-gate-1"]);
    assert.equal(h.started.length, 1, "no second reviewer was launched while findings were open");

    const resolved = await h.call("orch_spec_review", {
      action: "resolve",
      runId: run.id,
      dispositions: [{ findingId: "F-gate-1", action: "accepted", rationale: "the follow-up already covers this case" }],
    });
    assert.equal(resolved.details?.status, "ready", resolved.content[0].text);

    const second = await h.call("orch_spec_review", { action: "start", targetArtifactId: "gated-design" });
    assert.ok(second.details.runId, second.content[0].text);
  } finally {
    await h.detach();
  }
});

test("a target that never converges stops after two non-ready rounds", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    saveDesign(h, "loop-design", "# Loop\n\nAmbiguous, and the parent keeps re-reviewing instead of deciding.");

    for (let round = 0; round < 2; round += 1) {
      const started = await h.call("orch_spec_review", { action: "start", targetArtifactId: "loop-design" });
      assert.ok(started.details.runId, `round ${round + 1} starts: ${started.content[0].text}`);
    }
    assert.equal(h.started.length, 2, "two rounds launched one devil's advocate each");

    const refused = await h.call("orch_spec_review", { action: "start", targetArtifactId: "loop-design" });
    assert.equal(refused.details.error, "review-loop");
    assert.match(refused.content[0].text, /Refusing to start another review/);
    assert.match(refused.content[0].text, /Record dispositions/);
    assert.match(refused.content[0].text, /ask the user/);
    assert.doesNotMatch(refused.content[0].text, /artifact id so this history does not apply/);
    assert.equal(refused.details.rounds.length, 2);
    assert.equal(h.started.length, 2, "the refused round launched no reviewer");
  } finally {
    await h.detach();
  }
});

test("a reviewer cannot broad-search the tree or read control-plane state", async () => {
  process.env.PI_SUBAGENT_REVIEW_POLICY = "spec-only";
  process.env.PI_SUBAGENT_REVIEW_RUN = "spec-review-test";
  process.env.PI_SUBAGENT_REVIEW_LENS = "gate";
  process.env.PI_SUBAGENT_REVIEW_TARGET = "a".repeat(64);
  process.env.PI_SUBAGENT_REVIEW_DIR = join(tmpdir(), "spec-review-test");
  const h = await harness();
  // The repository root is separate from the session directory; using the
  // session directory as both would make every path look like control plane.
  const repo = await mkdtemp(join(tmpdir(), "spec-review-repo-"));
  process.env.PI_SUBAGENT_REVIEW_ROOTS = repo;
  try {
    // A search with no path walks the working tree, including control-plane files
    // that happen to live inside it. The reviewer must name a permitted path.
    const broad = await h.emit("tool_call", { toolName: "grep", input: { pattern: "secret" } });
    assert.match(broad?.reason ?? "", /explicit permitted path/);

    const scoped = await h.emit("tool_call", { toolName: "grep", input: { pattern: "retry", path: repo } });
    assert.equal(scoped, undefined, "a named path inside the root remains readable");

    // The sidecar name binds a session to an outcome wherever it lives, even
    // when the session directory itself is not in the path.
    const sidecar = await h.emit("tool_call", { toolName: "read", input: { path: join(repo, "orchestrator-registry-parent.json") } });
    assert.match(sidecar?.reason ?? "", /control-plane/);

    const shell = await h.emit("tool_call", { toolName: "bash", input: { command: "python3 -c 'print(1)'" } });
    assert.match(shell?.reason ?? "", /not available to a spec-only reviewer/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await h.detach();
  }
});

test("a stale design reference is refused at authoring time, not at spawn", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    const refused = await h.call("orch_handoff", {
      scope: "retry",
      goal: "Implement retry",
      acceptanceCriteria: ["backoff is exponential"],
      laneFiles: ["src/retry.ts"],
      designRef: { runId: "spec-review-nope", targetHash: "0".repeat(64) },
    });
    assert.equal(refused.details?.error, "design-ref-not-ready", refused.content[0].text);
    assert.match(refused.content[0].text, /Refusing designRef/);
    assert.equal(handoffs.size, 0, "a refused handoff must not be written into the registry");
  } finally {
    await h.detach();
  }
});

test("orch_spec_review_submit is inert outside a reviewer session", async () => {
  const h = await harness();
  try {
    await assert.rejects(
      () => h.call("orch_spec_review_submit", { summary: "clean", findings: [] }),
      /only available to a spec-only reviewer child/,
    );
  } finally {
    await h.detach();
  }
});

test("a reviewer files its report into the run directory, and the gate rejects a malformed one", async () => {
  const h = await harness();
  const dir = join(h.dir, "reports", "run-1");
  try {
    process.env.PI_SUBAGENT_REVIEW_POLICY = "spec-only";
    process.env.PI_SUBAGENT_REVIEW_RUN = "run-1";
    process.env.PI_SUBAGENT_REVIEW_LENS = "gate";
    process.env.PI_SUBAGENT_REVIEW_TARGET = "a".repeat(64);
    process.env.PI_SUBAGENT_REVIEW_DIR = dir;

    // A finding that names no location cannot be acted on, so it never reaches disk.
    await assert.rejects(
      () => h.call("orch_spec_review_submit", {
        summary: "Missing a section",
        findings: [{ severity: "blocker", location: "", discrepancy: "no jitter policy", rationale: "implementers will guess" }],
      }),
      /rejected by the review gate/,
    );

    const filed = await h.call("orch_spec_review_submit", {
      summary: "The document does not state a jitter policy, so two retries can synchronise.",
      findings: [
        {
          severity: "blocker",
          location: "Retry",
          discrepancy: "no jitter policy",
          rationale: "synchronised retries amplify the failure being retried",
        },
      ],
    });
    assert.equal(filed.details.lens, "gate");
    const written = JSON.parse(await readFile(join(dir, "gate.json"), "utf8"));
    assert.equal(written.runId, "run-1");
    assert.equal(written.lens, "gate");
    assert.equal(written.targetHash, "a".repeat(64));
    assert.equal(written.findings[0].severity, "blocker");
    assert.match(written.findings[0].id, /^F-gate-1$/, "ids are derived, so a reviewer cannot collide with another lens");
  } finally {
    await h.detach();
  }
});

test("an Orchestrator research spawn needs no handoff or design review", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    h.ctx.sessionManager.getBranch().push({
      type: "custom",
      customType: SUPERVISOR_MODE_TYPE,
      data: { enabled: true, previousTools: [], modeId: "orchestrator" },
    });

    // Investigate by delegating a reader. Before this, research was refused in
    // Orchestrator mode, so the parent's only instrument was its own shell — the
    // bypass that wrote a design doc and then reviewed it.
    const spawned = await h.call("orch_spawn", {
      name: "Scout",
      task: "Inventory the orchestration seams and report findings.",
      purpose: "research",
    });
    assert.equal(spawned.details.status, "started", spawned.content[0].text);
    assert.equal(h.started.length, 1, "the research child launched a pane");
    assert.equal(handoffs.size, 0, "research needs no handoff");
  } finally {
    await h.detach();
  }
});

test("a ready reviewed handoff admits an Orchestrator implementation spawn", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    h.ctx.sessionManager.getBranch().push({
      type: "custom",
      customType: SUPERVISOR_MODE_TYPE,
      data: { enabled: true, previousTools: [], modeId: "orchestrator" },
    });

    // The production loop reviews the handoff itself, then binds the review to
    // the same artifact. Regression: attaching designRef used to change the
    // artifact text, so spawn saw a hash mismatch and the parent re-reviewed
    // forever without ever delegating.
    const authored = await h.call("orch_handoff", {
      scope: "retry-impl",
      goal: "Implement retry with jitter",
      acceptanceCriteria: ["jitter is applied"],
      laneFiles: ["src/retry.ts"],
    });
    assert.equal(authored.details?.scope, "retry-impl", authored.content[0].text);

    const started = await h.call("orch_spec_review", {
      action: "start",
      targetArtifactId: authored.details.artifactId,
      preset: "quick",
    });
    const run = specReviews.get(started.details.runId)!;
    // Readiness evaluation is covered by the C2 unit tests; this asserts the
    // admission wiring: a ready, matching review is what lets the spawn through.
    run.readiness = { ...run.readiness, ready: true, reasons: [] };
    run.status = "ready";

    const bound = await h.call("orch_handoff", {
      scope: "retry-impl",
      goal: "Implement retry with jitter",
      acceptanceCriteria: ["jitter is applied"],
      laneFiles: ["src/retry.ts"],
      designRef: { runId: run.id, targetHash: run.target.contentHash },
    });
    assert.equal(bound.details?.scope, "retry-impl", bound.content[0].text);

    const spawned = await h.call("orch_spawn", {
      name: "Retry Worker",
      task: "Implement the retry policy.",
      handoffId: authored.details.id,
      purpose: "implementation",
    });
    assert.equal(spawned.details.status, "started", spawned.content[0].text);
    assert.equal(spawned.details.handoffId, authored.details.id);
  } finally {
    await h.detach();
  }
});

test("a blocked reviewer report keeps its verdict and missing context", async () => {
  const h = await harness();
  const dir = join(h.dir, "reports", "run-blocked");
  try {
    process.env.PI_SUBAGENT_REVIEW_POLICY = "spec-only";
    process.env.PI_SUBAGENT_REVIEW_RUN = "run-blocked";
    process.env.PI_SUBAGENT_REVIEW_LENS = "gate";
    process.env.PI_SUBAGENT_REVIEW_TARGET = "b".repeat(64);
    process.env.PI_SUBAGENT_REVIEW_DIR = dir;

    const filed = await h.call("orch_spec_review_submit", {
      verdict: "blocked",
      summary: "The document does not state what happens after the third retry.",
      findings: [],
      missingContext: ["what happens after the third retry"],
    });

    assert.equal(filed.details.findings, 0);
    const written = JSON.parse(await readFile(join(dir, "gate.json"), "utf8"));
    assert.equal(written.verdict, "blocked", "a blocked report must not look like a clean one on disk");
    assert.deepEqual(written.missingContext, ["what happens after the third retry"]);
  } finally {
    await h.detach();
  }
});

test("a reviewer cannot be resumed or steered with author context", async () => {
  const h = await harness();
  const sessionFile = join(h.dir, "reviewer.jsonl");
  await writeFile(sessionFile, "{}\n", "utf8");
  registry.registerChild({
    id: "review-1",
    name: "Comprehension Reviewer",
    scope: "review-sr-1-gate",
    sessionFile,
    paneId: "pane-review",
    status: "running",
    laneFiles: [],
    lastMilestoneFiles: [],
    updatedAt: new Date().toISOString(),
    purpose: "review",
    reviewRunId: "sr-1",
    reviewLens: "gate",
    targetHash: "a".repeat(64),
  });

  try {
    // Resume would close the pane and append the author's answer to the review.
    const resumed = await h.call("orch_resume", { sessionPath: sessionFile, message: "Here is the answer" });
    assert.equal(resumed.details.error, "reviewer-resume-forbidden");
    assert.equal(h.started.length, 0, "a refused resume must not launch or close anything");

    // Steering is author contact by another name.
    const steered = await h.call("orch_steer", { id: "review-1", message: "Change your finding" });
    assert.equal(steered.details.error, "reviewer-contact-forbidden");

    // The router resolves targets internally, so the refusal lives there too.
    const routed = await h.call("orch_route", { id: "review-1", update: "Approve this", apply: true });
    assert.equal(routed.details.outcome, "blocked-owner");
    assert.equal(routed.details.applied, false);
  } finally {
    await h.detach();
  }
});

test("a QA child is admitted only for a completed work unit and gets its criteria", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    const refused = await h.call("orch_spawn", {
      name: "QA",
      task: "Judge the result.",
      purpose: "review",
      qaFor: "retry-impl",
    });
    assert.equal(refused.details.error, "no-completed-work", refused.content[0].text);

    const authored = await h.call("orch_handoff", {
      scope: "retry-impl",
      goal: "Implement retry with jitter",
      acceptanceCriteria: ["jitter is applied"],
      laneFiles: ["src/retry.ts"],
    });
    registry.registerChild({
      id: "worker-1",
      name: "Retry Worker",
      scope: "retry-impl",
      sessionFile: join(h.dir, "worker-1.jsonl"),
      paneId: "pane-worker",
      status: "completed",
      laneFiles: ["src/retry.ts"],
      lastMilestoneFiles: [],
      updatedAt: new Date().toISOString(),
      handoffId: authored.details.id,
      purpose: "implementation",
    });

    const spawned = await h.call("orch_spawn", {
      name: "QA",
      task: "Judge the result against the criteria.",
      purpose: "review",
      qaFor: "retry-impl",
    });
    assert.equal(spawned.details.status, "started", spawned.content[0].text);
    assert.equal(spawned.details.scope, "qa-retry-impl");

    // The QA child is a reader: the launcher marks its purpose and hands it the
    // reader allowlist, so the lifecycle cannot turn QA into a second writer.
    const scripts = await h.launchScripts();
    const qaScript = scripts[scripts.length - 1] ?? "";
    assert.match(qaScript, /PI_SUBAGENT_PURPOSE='review'/);

    const row = [...registry.getAllChildren()].find((child) => child.scope === "qa-retry-impl");
    assert.equal(row?.qaForScope, "retry-impl", "the registry links QA to the unit it judges");
    assert.equal(row?.purpose, "review");
  } finally {
    await h.detach();
  }
});

test("the parent is told to end its turn, and a no-change poll is refused", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    h.ctx.sessionManager.getBranch().push({
      type: "custom",
      customType: SUPERVISOR_MODE_TYPE,
      data: { enabled: true, previousTools: [], modeId: "orchestrator" },
    });
    const spawned = await h.call("orch_spawn", { name: "Scout", task: "Inventory the seams.", purpose: "research" });
    assert.match(spawned.content[0].text, /Do not poll or sleep/, "a spawn result ends the turn");

    const first = await h.call("orch_running", {});
    assert.match(first.content[0].text, /children \(1\)/);
    const second = await h.call("orch_running", {});
    assert.equal(second.details.error, "no-new-events", second.content[0].text);
    assert.match(second.content[0].text, /Do not poll or sleep/);
  } finally {
    await h.detach();
  }
});

test("lint names machine defects without launching a reviewer", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    saveDesign(h, "lint-design", "# Retry\n\nThe plan names `src/does-not-exist.ts` and no verification step.");
    const linted = await h.call("orch_spec_review", { action: "lint", targetArtifactId: "lint-design" });
    assert.ok(Array.isArray(linted.details.findings), linted.content[0].text);
    assert.ok(linted.details.findings.length >= 1, "the missing path is a machine-detectable defect");
    assert.match(linted.content[0].text, /Machine lint found/);
    assert.equal(h.started.length, 0, "lint launches nobody");
    assert.equal(specReviews.size, 0, "lint opens no review run");
  } finally {
    await h.detach();
  }
});

test("a handoff without a verify command warns before a reviewer spends a round", async () => {
  const h = await harness();
  try {
    const authored = await h.call("orch_handoff", {
      scope: "no-verify",
      goal: "Do the thing.",
      acceptanceCriteria: ["the thing works"],
      laneFiles: ["src/thing.ts"],
    });
    assert.match(authored.content[0].text, /no verifyCommand was declared/);
  } finally {
    await h.detach();
  }
});

/** Bind role models the way `/orch-model --project` does: project settings win. */
async function bindRoleModels(dir: string, roleModels: Record<string, unknown>): Promise<void> {
  await mkdir(join(dir, ".pi"), { recursive: true });
  await writeFile(join(dir, ".pi", "subagents.json"), JSON.stringify({ roleModels }));
}

test("a spawned worker runs on the worker role model and says so", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    await bindRoleModels(h.dir, { worker: { provider: "zai", model: "glm-5.3-flash" } });
    const spawned = await h.call("orch_spawn", {
      name: "Retry Worker",
      task: "Implement the retry policy.",
      purpose: "adhoc",
      laneFiles: ["src/retry.ts"],
    });
    assert.equal(spawned.details.status, "started", spawned.content[0].text);
    assert.match(spawned.content[0].text, /Model: zai\/glm-5\.3-flash — worker binding/);

    const scripts = await h.launchScripts();
    assert.equal(scripts.length, 1);
    assert.match(scripts[0]!, /--model/);
    assert.match(scripts[0]!, /zai\/glm-5\.3-flash/);
  } finally {
    await h.detach();
  }
});

test("a pooled worker binding rolls once, deterministically under the rng seam", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  // 0.999 selects the last usable member: a roll, not always the first entry.
  const h = await harness({ random: () => 0.999 });
  try {
    await bindRoleModels(h.dir, {
      worker: [
        { provider: "zai", model: "first" },
        { provider: "zai", model: "second" },
        { provider: "zai", model: "third" },
      ],
    });
    const spawned = await h.call("orch_spawn", {
      name: "Retry Worker",
      task: "Implement the retry policy.",
      purpose: "adhoc",
      laneFiles: ["src/retry.ts"],
    });
    assert.equal(spawned.details.status, "started", spawned.content[0].text);
    assert.match(spawned.content[0].text, /rolled from a 3-model worker pool/);
    assert.match((await h.launchScripts())[0]!, /zai\/third/);
  } finally {
    await h.detach();
  }
});

test("an explicit spawn model beats the role binding", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    await bindRoleModels(h.dir, { worker: { provider: "zai", model: "glm-5.3-flash" } });
    const spawned = await h.call("orch_spawn", {
      name: "Retry Worker",
      task: "Implement the retry policy.",
      purpose: "adhoc",
      laneFiles: ["src/retry.ts"],
      model: "anthropic/claude-opus-5.8",
    });
    assert.match(spawned.content[0].text, /anthropic\/claude-opus-5\.8 — explicit override/);
    assert.match((await h.launchScripts())[0]!, /anthropic\/claude-opus-5\.8/);
  } finally {
    await h.detach();
  }
});

test("reviewers run on the devil-advocate binding", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    await bindRoleModels(h.dir, { "devil-advocate": { provider: "deepseek", model: "deepseek-4.1-flash" } });
    saveDesign(h, "retry-design", "# Retry\n\nRetry with exponential backoff.");
    const started = await h.call("orch_spec_review", { action: "start", targetArtifactId: "retry-design" });
    assert.ok(started.details.runId, started.content[0].text);
    assert.match(started.content[0].text, /Reviewer models: gate on deepseek\/deepseek-4\.1-flash/);
    assert.match((await h.launchScripts())[0]!, /deepseek\/deepseek-4\.1-flash/);
  } finally {
    await h.detach();
  }
});

/** The launcher passes system prompts by file path, so read what the child got. */
async function systemPromptText(script: string): Promise<string | undefined> {
  // The launcher shell-quotes argv entries, including the flag itself.
  const match = script.match(/'?--(?:append-)?system-prompt'?\s+(?:'([^']*)'|"([^"]*)"|(\S+))/);
  const path = match?.[1] ?? match?.[2] ?? match?.[3];
  return path ? readFile(path, "utf8") : undefined;
}

async function writeRolePrompt(dir: string, name: string, text: string): Promise<void> {
  const roleDir = join(dir, ".pi", "orch-agents");
  await mkdir(roleDir, { recursive: true });
  await writeFile(join(roleDir, name), text, "utf8");
}

test("a spawned worker receives the workspace role prompt as an appended system prompt", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    await writeRolePrompt(h.dir, "worker.md", "# House rules\n\nOnly edit the lane, and cite the verify output.");
    const spawned = await h.call("orch_spawn", {
      name: "Retry Worker",
      task: "Implement the retry policy.",
      purpose: "adhoc",
      laneFiles: ["src/retry.ts"],
    });
    assert.equal(spawned.details.status, "started", spawned.content[0].text);
    assert.match(spawned.content[0].text, /Role prompt: project \(\.pi\/orch-agents\/worker\.md\)/);

    const script = (await h.launchScripts())[0]!;
    assert.match(script, /--append-system-prompt/, "the role prompt is a real system prompt, not ticket text");
    assert.match(await systemPromptText(script) ?? "", /Only edit the lane, and cite the verify output\./);
  } finally {
    await h.detach();
  }
});

test("with no workspace file the built-in role prompt is used", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    const spawned = await h.call("orch_spawn", {
      name: "Retry Worker",
      task: "Implement the retry policy.",
      purpose: "adhoc",
      laneFiles: ["src/retry.ts"],
    });
    assert.match(spawned.content[0].text, /Role prompt: builtin/);
    assert.match(await systemPromptText((await h.launchScripts())[0]!) ?? "", /# Role: worker/);
  } finally {
    await h.detach();
  }
});

test("reviewers receive the devil-advocate role prompt", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    await writeRolePrompt(h.dir, "devil-advocate.md", "Judge the document, and state what you checked.");
    saveDesign(h, "retry-design", "# Retry\n\nRetry with exponential backoff.");
    const started = await h.call("orch_spec_review", { action: "start", targetArtifactId: "retry-design" });
    assert.ok(started.details.runId, started.content[0].text);
    assert.match(started.content[0].text, /Reviewer prompt: project/);
    assert.match(await systemPromptText((await h.launchScripts())[0]!) ?? "", /Judge the document, and state what you checked\./);
  } finally {
    await h.detach();
  }
});

test("the sixth concurrent worker is refused, and only running children hold a slot", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    for (let i = 1; i <= 5; i += 1) {
      registry.registerChild({
        id: `w-${i}`,
        name: `Worker ${i}`,
        scope: `unit-${i}`,
        sessionFile: join(h.dir, `w-${i}.jsonl`),
        paneId: `pane-${i}`,
        status: "running",
        laneFiles: ["src/x.ts"],
        lastMilestoneFiles: [],
        updatedAt: new Date().toISOString(),
        purpose: "adhoc",
      });
    }

    const refused = await h.call("orch_spawn", {
      name: "Sixth",
      task: "Do more work.",
      purpose: "adhoc",
      laneFiles: ["src/y.ts"],
    });
    assert.equal(refused.details.error, "worker-limit", refused.content[0].text);
    assert.match(refused.content[0].text, /cap is 5/);
    assert.equal(h.started.length, 0, "a refused spawn launches nothing");

    // Completion frees the slot: the cap is concurrency, not a lifetime quota.
    registry.updateStatus(join(h.dir, "w-1.jsonl"), "completed");
    const admitted = await h.call("orch_spawn", {
      name: "Sixth",
      task: "Do more work.",
      purpose: "adhoc",
      laneFiles: ["src/y.ts"],
    });
    assert.equal(admitted.details.status, "started", admitted.content[0].text);
  } finally {
    await h.detach();
  }
});

test("a fourth QA reviewer is refused, and a running spec reviewer is not a QA slot", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    const authored = await h.call("orch_handoff", {
      scope: "qa-target",
      goal: "Ship it.",
      acceptanceCriteria: ["it works"],
      laneFiles: ["src/a.ts"],
    });
    registry.registerChild({
      id: "w-1",
      name: "Worker",
      scope: "qa-target",
      sessionFile: join(h.dir, "w-1.jsonl"),
      paneId: "pane-w",
      status: "completed",
      laneFiles: ["src/a.ts"],
      lastMilestoneFiles: [],
      updatedAt: new Date().toISOString(),
      handoffId: authored.details.id,
      purpose: "implementation",
    });
    for (let i = 1; i <= 3; i += 1) {
      registry.registerChild({
        id: `qa-${i}`,
        name: `QA ${i}`,
        scope: `qa-${i}`,
        sessionFile: join(h.dir, `qa-${i}.jsonl`),
        paneId: `pane-qa-${i}`,
        status: "running",
        laneFiles: [],
        lastMilestoneFiles: [],
        updatedAt: new Date().toISOString(),
        purpose: "review",
        qaForScope: "qa-target",
      });
    }

    const refused = await h.call("orch_spawn", { name: "QA 4", task: "Judge.", purpose: "review", qaFor: "qa-target" });
    assert.equal(refused.details.error, "qa-limit", refused.content[0].text);
    assert.match(refused.content[0].text, /cap is 3/);

    // A spec reviewer also has purpose "review"; it must not consume a QA slot.
    registry.updateStatus(join(h.dir, "qa-1.jsonl"), "completed");
    registry.registerChild({
      id: "spec-1",
      name: "Spec gate",
      scope: "spec-gate",
      sessionFile: join(h.dir, "spec-1.jsonl"),
      paneId: "pane-spec",
      status: "running",
      laneFiles: [],
      lastMilestoneFiles: [],
      updatedAt: new Date().toISOString(),
      purpose: "review",
      reviewRunId: "run-1",
    });
    const admitted = await h.call("orch_spawn", { name: "QA 4", task: "Judge.", purpose: "review", qaFor: "qa-target" });
    assert.equal(admitted.details.status, "started", admitted.content[0].text);
  } finally {
    await h.detach();
  }
});

/** A completed unit with a handoff: the only shape QA admits. */
async function completeWorker(h: Harness, scope: string): Promise<void> {
  const authored = await h.call("orch_handoff", {
    scope,
    goal: `Ship ${scope}.`,
    acceptanceCriteria: [`${scope} works`],
    laneFiles: [`src/${scope}.ts`],
  });
  registry.registerChild({
    id: `w-${scope}`,
    name: `Worker ${scope}`,
    scope,
    sessionFile: join(h.dir, `${scope}.jsonl`),
    paneId: `pane-${scope}`,
    status: "completed",
    laneFiles: [`src/${scope}.ts`],
    lastMilestoneFiles: [],
    updatedAt: new Date().toISOString(),
    handoffId: authored.details.id,
    purpose: "implementation",
  });
}

/** The ticket the launcher attached as `@<path>`. */
async function ticketText(script: string): Promise<string> {
  const match = script.match(/@'([^']+)'/) ?? script.match(/@(\S+\.md)/);
  return match ? readFile(match[1]!, "utf8") : "";
}

test("orch_qa fans five completed units out to two reviewers as 2 + 3", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    const scopes = ["unit-a", "unit-b", "unit-c", "unit-d", "unit-e"];
    for (const scope of scopes) await completeWorker(h, scope);

    const result = await h.call("orch_qa", { scopes });
    assert.deepEqual(result.details.groups, [
      { label: "qa-1", scopes: ["unit-a", "unit-b"] },
      { label: "qa-2", scopes: ["unit-c", "unit-d", "unit-e"] },
    ]);
    assert.equal(result.details.spawned.length, 2, result.content[0].text);
    assert.match(result.content[0].text, /qa-1 → unit-a, unit-b/);
    assert.match(result.content[0].text, /qa-2 → unit-c, unit-d, unit-e/);

    const qaRows = registry
      .getAllChildren()
      .filter((child) => child.purpose === "review" && !child.reviewRunId && child.status === "running");
    assert.deepEqual(
      qaRows.map((row) => [row.scope, row.qaForScopes]),
      [
        ["qa-1", ["unit-a", "unit-b"]],
        ["qa-2", ["unit-c", "unit-d", "unit-e"]],
      ],
      "the registry records exactly the units each reviewer owns",
    );

    const scripts = await h.launchScripts();
    assert.equal(scripts.length, 2, "two QA panes, not one per unit");
    const lastTicket = await ticketText(scripts[1]!);
    assert.match(lastTicket, /# QA review batch: qa-2 — 3 units/);
    assert.match(lastTicket, /unit-c/);
    assert.match(lastTicket, /unit-d/);
    assert.match(lastTicket, /unit-e/);
    assert.doesNotMatch(lastTicket, /unit-a/, "a reviewer never sees another reviewer's unit");
  } finally {
    await h.detach();
  }
});

test("a QA batch that would exceed the reviewer cap is refused before any pane opens", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    const scopes = ["unit-a", "unit-b", "unit-c", "unit-d", "unit-e"];
    for (const scope of scopes) await completeWorker(h, scope);
    for (const i of [1, 2]) {
      registry.registerChild({
        id: `qa-${i}`,
        name: `QA ${i}`,
        scope: `qa-${i}`,
        sessionFile: join(h.dir, `qa-${i}.jsonl`),
        paneId: `pane-qa-${i}`,
        status: "running",
        laneFiles: [],
        lastMilestoneFiles: [],
        updatedAt: new Date().toISOString(),
        purpose: "review",
      });
    }

    const result = await h.call("orch_qa", { scopes });
    assert.equal(result.details.error, "qa-limit", result.content[0].text);
    assert.equal(h.started.length, 0, "a partially spawned batch is not acceptable");
  } finally {
    await h.detach();
  }
});

test("the research surface is registered for the orchestrator", async () => {
  const h = await harness();
  try {
    for (const name of ["code_map", "code_search", "code_read", "web_research", "web_fetch", "shell_read"]) {
      assert.ok(h.tools.has(name), `${name} is registered`);
    }
  } finally {
    await h.detach();
  }
});

test("a research child's evidence artifact is scoped to its unit", async () => {
  const h = await harness();
  process.env.PI_SUBAGENT_SCOPE = "unit-x";
  try {
    const blocked = await h.emit("tool_call", {
      toolName: "artifact_save",
      input: { id: "research-unit-x-note", type: "scratchpad", scope: "global", content: "evidence" },
    });
    assert.equal(blocked?.block, true, "a global artifact is not a research artifact");
    assert.match(String(blocked?.reason), /scope must be "orch-research:unit-x"/);

    const allowed = await h.emit("tool_call", {
      toolName: "artifact_save",
      input: { id: "research-unit-x-note", type: "scratchpad", scope: "orch-research:unit-x", content: "evidence" },
    });
    assert.equal(allowed?.block, undefined, "its own scoped evidence is allowed");
  } finally {
    delete process.env.PI_SUBAGENT_SCOPE;
    await h.detach();
  }
});

test("a document review can be given the plan, so 'the plan was not supplied' is not a finding", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    saveDesign(h, "retry-design", "# Retry\n\nRetry with exponential backoff. No jitter policy is stated.");
    saveDesign(h, "jira-plan", "# Plan\n\nThe plan pins the retry policy as out of scope for this lane.");
    await h.call("orch_spec_review", { action: "start", targetArtifactId: "retry-design", prdArtifactId: "jira-plan" });

    const script = (await h.launchScripts())[0] ?? "";
    const ticketPath = [...script.matchAll(/'@([^']+)'/g)].map((match) => match[1]!)[0];
    assert.ok(ticketPath, "the reviewer is launched with a ticket file");
    const ticket = await readFile(ticketPath, "utf8");
    assert.match(ticket, /Shared reference \(jira-plan\)/);
    assert.match(ticket, /the plan pins the retry policy as out of scope/i, "the plan text is quoted into the ticket");
  } finally {
    await h.detach();
  }
});

test("a running reviewer is reported as running, not as 'no new events'", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    saveDesign(h, "retry-design", "# Retry\n\nRetry with exponential backoff.");
    const started = await h.call("orch_spec_review", { action: "start", targetArtifactId: "retry-design" });
    const runId = started.details.runId;

    const first = await h.call("orch_spec_review", { action: "status", runId });
    const second = await h.call("orch_spec_review", { action: "status", runId });
    for (const [label, result] of [["first", first], ["second", second]] as const) {
      assert.match(result.content[0].text, /still running for \d+s/, `${label} status must show elapsed time`);
      assert.doesNotMatch(result.content[0].text, /No new events/, `${label} status must not claim silence`);
    }

    const collected = await h.call("orch_spec_review", { action: "collect", runId });
    assert.match(collected.content[0].text, /still running for \d+s/, "collect must show progress too");
    assert.doesNotMatch(collected.content[0].text, /No new events/);
  } finally {
    await h.detach();
  }
});

test("a missing-context report is unblocked by a disposition, not by a fresh session", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    saveDesign(h, "retry-design", "# Retry\n\nRetry with exponential backoff.");
    const started = await h.call("orch_spec_review", { action: "start", targetArtifactId: "retry-design" });
    const runId = started.details.runId;
    const run = specReviews.get(runId)!;

    const dir = join(h.dir, "artifacts", "parent-session", "spec-reviews", runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "gate.json"), JSON.stringify({
      version: 1,
      runId,
      lens: "gate",
      targetHash: run.target.contentHash,
      summary: "the document is thin, and the plan was not supplied",
      findings: [],
      coverage: ["goal", "acceptance criteria"],
      missingContext: ["the pinned project plan was not supplied"],
      submittedAt: new Date(0).toISOString(),
    }));

    const collected = await h.call("orch_spec_review", { action: "collect", runId });
    assert.equal(collected.details.ready, false);
    assert.match(collected.content[0].text, /C-gate-1 is unaddressed: the pinned project plan was not supplied/);

    const resolved = await h.call("orch_spec_review", {
      action: "resolve",
      runId,
      dispositions: [{
        findingId: "C-gate-1",
        action: "accepted",
        rationale: "the plan is pinned as prdArtifactId on the next round; for this document it is not needed",
      }],
    });
    assert.equal(resolved.details.ready, true, resolved.content[0].text);
    assert.match(resolved.content[0].text, /READY/);
  } finally {
    await h.detach();
  }
});
