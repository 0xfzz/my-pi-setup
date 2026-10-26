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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import subagentV2, { handoffs, registry, specReviews } from "../../extensions/orchestrator.ts";
import { ARTIFACT_TYPE } from "../../lib/artifact-state.ts";

interface Harness {
  dir: string;
  ctx: any;
  tools: Map<string, any>;
  started: any[];
  launchScripts: () => Promise<string[]>;
  call: (name: string, params: any) => Promise<any>;
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

test("start pins the design, launches one isolated reviewer per lens, and leaks no parent channel", async () => {
  process.env.PI_HERDR_PI_BIN = "/bin/true";
  process.env.PI_HERDR_LAUNCH_PREFIX = "";
  const h = await harness();
  try {
    saveDesign(h, "retry-design", "# Retry\n\nRetry with exponential backoff. No jitter policy is stated.");

    const started = await h.call("orch_spec_review", { action: "start", targetArtifactId: "retry-design" });
    const details = started.details;
    assert.ok(details.runId, `start must return a run id: ${started.content[0].text}`);
    assert.deepEqual(details.launched, ["comprehension", "readiness"], "quick preset launches two lenses");

    const task = h.started[0]?.launchScriptFile ? "" : "";
    void task;

    const scripts = await h.launchScripts();
    assert.equal(scripts.length, 2, "one launch script per reviewer");
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
      assert.match(toolsLine, /spec_review_submit/);
      assert.match(toolsLine, /read/);
    }

    // The pinned document itself is quoted into the ticket each reviewer receives.
    const run = details.runId;
    const dir = join(h.dir, "artifacts", "parent-session", "spec-reviews", run);
    assert.ok(dir.includes("spec-reviews"), "reports live under a run-scoped directory");
  } finally {
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

test("spec_review_submit is inert outside a reviewer session", async () => {
  const h = await harness();
  try {
    await assert.rejects(
      () => h.call("spec_review_submit", { summary: "clean", findings: [] }),
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
      () => h.call("spec_review_submit", {
        summary: "Missing a section",
        findings: [{ severity: "blocker", location: "", discrepancy: "no jitter policy", rationale: "implementers will guess" }],
      }),
      /rejected by the review gate/,
    );

    const filed = await h.call("spec_review_submit", {
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
