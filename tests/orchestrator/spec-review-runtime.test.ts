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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function harness(): Promise<Harness> {
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

  subagentV2(pi, { client, stream: { watch: () => () => {}, onReconcile: () => () => {} } });

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
    // The spec phase is the orchestrator plus ONE devil's advocate. A panel is an
    // explicit opt-in, not the default that made every spec a review career.
    assert.deepEqual(details.launched, ["gate"], "the default single preset launches one reviewer");

    const scripts = await h.launchScripts();
    assert.equal(scripts.length, 1, "one launch script for the one reviewer");
    for (const script of scripts) {
      // Isolation is structural: no parent transcript pointer, no artifact writer,
      // no shell. The reviewer judges a snapshot it was handed.
      assert.doesNotMatch(script, /PI_SUBAGENT_PARENT=/, "a reviewer must not receive the parent transcript pointer");
      assert.match(script, /PI_SUBAGENT_REVIEW_POLICY='spec-only'/);
      const toolsLine = script.split("\n").find((line) => line.includes("--tools")) ?? "";
      assert.ok(toolsLine, "the reviewer is launched with an explicit tool allowlist");
      for (const forbidden of ["bash", "write", "edit", "artifact_save", "orch_parent_recall", "orch_parent_digest"]) {
        assert.ok(
          !new RegExp(`(^|[,='\"\\s])${forbidden}([,='\"\\s]|$)`).test(toolsLine),
          `reviewer tool allowlist must not include ${forbidden}: ${toolsLine}`,
        );
      }
      assert.match(toolsLine, /orch_spec_review_submit/);
      assert.match(toolsLine, /read/);
    }

    // A panel remains available, explicitly and expensively.
    const panel = await h.call("orch_spec_review", { action: "start", targetArtifactId: "retry-design", preset: "quick" });
    assert.deepEqual(panel.details.launched, ["comprehension", "readiness"], "quick stays opt-in");

    // The pinned document itself is quoted into the ticket each reviewer receives.
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
  process.env.PI_SUBAGENT_REVIEW_LENS = "readiness";
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
    process.env.PI_SUBAGENT_REVIEW_LENS = "readiness";
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
    assert.equal(filed.details.lens, "readiness");
    const written = JSON.parse(await readFile(join(dir, "readiness.json"), "utf8"));
    assert.equal(written.runId, "run-1");
    assert.equal(written.lens, "readiness");
    assert.equal(written.targetHash, "a".repeat(64));
    assert.equal(written.findings[0].severity, "blocker");
    assert.match(written.findings[0].id, /^F-readiness-1$/, "ids are derived, so a reviewer cannot collide with another lens");
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
    process.env.PI_SUBAGENT_REVIEW_LENS = "readiness";
    process.env.PI_SUBAGENT_REVIEW_TARGET = "b".repeat(64);
    process.env.PI_SUBAGENT_REVIEW_DIR = dir;

    const filed = await h.call("orch_spec_review_submit", {
      verdict: "blocked",
      summary: "The document does not state what happens after the third retry.",
      findings: [],
      missingContext: ["what happens after the third retry"],
    });

    assert.equal(filed.details.findings, 0);
    const written = JSON.parse(await readFile(join(dir, "readiness.json"), "utf8"));
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
    scope: "review-sr-1-comprehension",
    sessionFile,
    paneId: "pane-review",
    status: "running",
    laneFiles: [],
    lastMilestoneFiles: [],
    updatedAt: new Date().toISOString(),
    purpose: "review",
    reviewRunId: "sr-1",
    reviewLens: "comprehension",
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
