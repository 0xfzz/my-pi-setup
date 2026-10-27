/**
 * The gate must fail closed.
 *
 * Each test here is one stated invariant, named after it, so a regression points
 * at the property that broke rather than at the nearest function. The failure
 * these replace was silent: every one of them let an `approved` verdict through
 * with evidence the module comments say cannot license one.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import orchestratorExtension, { handoffs, registry, reviewSeams } from "../../extensions/orchestrator.ts";
import type { HandoffRecord } from "../../lib/orchestrator/handoff.ts";

interface Harness {
  tools: Map<string, any>;
  ctx: any;
}

function harness(dir: string): Harness {
  const tools = new Map<string, any>();
  const pi: any = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on() {},
    sendMessage() {},
    appendEntry() {},
    getAllTools() {
      return [...tools.values()];
    },
  };
  const ctx: any = {
    cwd: dir,
    ui: { notify() {} },
    sessionManager: {
      getBranch: () => [],
      getSessionDir: () => dir,
      getSessionId: () => "parent-fail-closed",
      getSessionFile: () => join(dir, "parent.jsonl"),
    },
  };
  orchestratorExtension(pi, {
    client: { paneGet: async () => null, paneList: async () => [], paneClose: async () => {} } as any,
    stream: { watch: () => () => {}, onReconcile: () => () => {} },
    now: () => 10_000_000,
    watchdogIntervalMs: 30_000,
  });
  return { tools, ctx };
}

function handoff(scope: string, over: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    id: `handoff-${scope}`,
    artifactId: `handoff-art-${scope}`,
    scope,
    goal: `do ${scope}`,
    acceptanceCriteria: [`${scope} works`],
    laneFiles: ["src/net/"],
    outOfLaneFiles: [],
    revision: 1,
    authoredAt: new Date(0).toISOString(),
    parentSessionId: "parent-fail-closed",
    ...over,
  } as HandoffRecord;
}

const call = (h: Harness, name: string, params: any) =>
  h.tools.get(name).execute("t", params, undefined, undefined, h.ctx);

describe("gate integrity: fail closed on what the gate could not observe", () => {
  beforeEach(() => {
    registry.resetForTests();
    handoffs.clear();
    reviewSeams.changedFiles = () => [];
    reviewSeams.diffText = () => "";
    reviewSeams.runCommand = () => ({ exit: 0, output: "ok" });
  });

  it("invariant: an unreadable tree never licenses an approval", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-failclosed-"));
    const h = harness(dir);
    handoffs.set("handoff-net", { record: handoff("net"), path: join(dir, "spec.md") });
    reviewSeams.changedFiles = () => null;
    try {
      const result = await call(h, "orch_review", {
        scope: "net",
        verdict: "approved",
        criteriaNotes: [{ criterion: "net works", evidenceRefs: [{ kind: "cmd", cmd: "npm test", exit: 0 }], passed: true }],
        summary: "trust me",
      });
      assert.equal(result.details.error, "tree-unreadable", JSON.stringify(result.details));
      assert.match(result.content[0].text, /NOT verified/);

      // A revise verdict is still recordable, and the gap becomes a finding.
      const revise = await call(h, "orch_review", {
        scope: "net",
        verdict: "revise",
        criteriaNotes: [{ criterion: "net works", passed: false }],
        summary: "cannot see the tree",
      });
      assert.equal(revise.details.verdict, "revise");
      assert.match(revise.details.findings?.join(" ") ?? "", /NOT verified/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("invariant: no receipt is minted for a tree nobody could read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-failclosed-"));
    const h = harness(dir);
    handoffs.set("handoff-net", { record: handoff("net", { verifyCommand: "npm test" }), path: join(dir, "spec.md") });
    reviewSeams.changedFiles = () => null;
    try {
      const result = await call(h, "orch_check", { scope: "net" });
      assert.equal(result.details.error, "tree-unreadable");
      assert.equal(result.details.checkRunId, null, "a receipt that describes nothing must not exist");
      assert.equal(result.details.receipt, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("invariant: a substituted check cannot approve the declared one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-failclosed-"));
    const h = harness(dir);
    handoffs.set("handoff-net", { record: handoff("net", { verifyCommand: "npm test" }), path: join(dir, "spec.md") });
    try {
      // The declared check is `npm test`; the parent runs the cheaper typechecker.
      const check = await call(h, "orch_check", { scope: "net", command: "npm run typecheck" });
      assert.ok(check.details.checkRunId, "the check still runs and records what it ran");

      const review = await call(h, "orch_review", {
        scope: "net",
        verdict: "approved",
        criteriaNotes: [
          { criterion: "net works", evidenceRefs: [{ kind: "cmd", cmd: "npm run typecheck", exit: 0 }], passed: true },
        ],
        summary: "typecheck is green",
        checkRunId: check.details.checkRunId,
      });
      assert.equal(review.details.error, "check-receipt-invalid");
      assert.ok(
        review.details.problems.some((p: string) => /declared|substituted/.test(p)),
        JSON.stringify(review.details.problems),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("invariant: every passing criterion carries its own reference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-failclosed-"));
    const h = harness(dir);
    await writeFile(join(dir, "a.ts"), "one\ntwo\n", "utf8");
    handoffs.set("handoff-net", {
      record: handoff("net", { acceptanceCriteria: ["net works", "jitter is applied"] }),
      path: join(dir, "spec.md"),
    });
    try {
      const result = await call(h, "orch_review", {
        scope: "net",
        verdict: "approved",
        criteriaNotes: [
          { criterion: "net works", evidenceRefs: [{ kind: "file", path: "a.ts" }], passed: true },
          { criterion: "jitter is applied", passed: true },
        ],
        summary: "one file reference for two claims",
      });
      assert.equal(result.details.error, "evidence-missing-per-criterion");
      assert.deepEqual(result.details.criteria, ["jitter is applied"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("invariant: a cited test must have printed in the cited receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-failclosed-"));
    const h = harness(dir);
    handoffs.set("handoff-net", {
      record: handoff("net", { verifyCommand: "npm test" }),
      path: join(dir, "spec.md"),
    });
    reviewSeams.runCommand = () => ({ exit: 0, output: "ok 1 - unrelated case\n# pass 1\n" });
    try {
      const check = await call(h, "orch_check", { scope: "net" });
      const review = await call(h, "orch_review", {
        scope: "net",
        verdict: "approved",
        criteriaNotes: [
          {
            criterion: "net works",
            evidenceRefs: [{ kind: "test", name: "jitter is applied", pass: true }],
            passed: true,
          },
        ],
        summary: "cited a test the suite never printed",
        checkRunId: check.details.checkRunId,
      });
      assert.equal(review.details.error, "test-ref-unobserved");
      assert.deepEqual(review.details.unobserved, ["jitter is applied"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a fully evidenced approval still passes, so the gate is not always-closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-failclosed-"));
    const h = harness(dir);
    await writeFile(join(dir, "a.ts"), "one\ntwo\n", "utf8");
    handoffs.set("handoff-net", {
      record: handoff("net", { verifyCommand: "npm test" }),
      path: join(dir, "spec.md"),
    });
    reviewSeams.runCommand = () => ({ exit: 0, output: "ok 1 - net works\n# pass 1\n" });
    try {
      const check = await call(h, "orch_check", { scope: "net" });
      const review = await call(h, "orch_review", {
        scope: "net",
        verdict: "approved",
        criteriaNotes: [
          {
            criterion: "net works",
            evidenceRefs: [
              { kind: "file", path: "a.ts" },
              { kind: "test", name: "ok 1 - net works", pass: true },
            ],
            passed: true,
          },
        ],
        summary: "receipt-backed and in lane",
        checkRunId: check.details.checkRunId,
      });
      assert.equal(review.details.verdict, "approved", JSON.stringify(review.details));
      assert.equal(review.details.laneSource, "git");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("invariant: attested evidence needs the user, because the gate cannot check it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-failclosed-"));
    const h = harness(dir);
    await writeFile(join(dir, "a.ts"), "one\n", "utf8");
    handoffs.set("handoff-net", {
      record: handoff("net", { acceptanceCriteria: ["no behaviour change"] }),
      path: join(dir, "spec.md"),
    });
    try {
      const refused = await call(h, "orch_review", {
        scope: "net",
        verdict: "approved",
        criteriaNotes: [
          { criterion: "no behaviour change", evidenceRefs: [{ kind: "file", path: "a.ts" }], attested: true, passed: true },
        ],
        summary: "attested",
      });
      assert.equal(refused.details.error, "attestation-requires-user");

      const confirmed = await call(h, "orch_review", {
        scope: "net",
        verdict: "approved",
        criteriaNotes: [
          { criterion: "no behaviour change", evidenceRefs: [{ kind: "file", path: "a.ts" }], attested: true, passed: true },
        ],
        summary: "user agreed this one cannot be evidenced",
        userConfirmed: true,
      });
      assert.equal(confirmed.details.verdict, "approved", JSON.stringify(confirmed.details));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
