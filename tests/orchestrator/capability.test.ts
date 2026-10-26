import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import orchestratorExtension, { handoffs, registry, reviewSeams } from "../../extensions/orchestrator.ts";
import { isControlPlanePath } from "../../lib/orchestrator/control-plane.ts";
import { checkEvidenceRefs, laneCoversPath } from "../../lib/orchestrator/evidence.ts";
import { isSupervisorTool, superviseModeFromBranch } from "../../lib/supervise-mode.ts";
import type { HandoffRecord } from "../../lib/orchestrator/handoff.ts";
import type { ScopedChild } from "../../lib/orchestrator/scope-registry.ts";

// ── one capability: the allowlist is the boundary ─────────────────────────────

describe("the orchestrator has exactly one capability", () => {
  it("hides write/edit and every opaque gateway", () => {
    for (const name of ["write", "edit", "browser", "browser_download", "generate_image", "powershell", "mcp__github__create_issue", "codemode", "mcp"]) {
      assert.equal(isSupervisorTool(name), false, `${name} must stay closed`);
    }
    for (const name of ["read", "bash", "orch_review", "orch_spawn", "artifact_save"]) {
      assert.equal(isSupervisorTool(name), true, `${name} must be usable`);
    }
  });

  it("denies a tool that claims destructiveHint, and an unknown tool without a read-only claim", () => {
    const tool = { name: "rm_rf", annotations: { destructiveHint: true } } as any;
    assert.equal(isSupervisorTool("rm_rf", tool), false);
    // Unknown extension/ MCP tools need an explicit read-only claim to be trusted.
    assert.equal(isSupervisorTool("some_server_search"), false);
    assert.equal(isSupervisorTool("some_server_search", { name: "x", annotations: { readOnlyHint: true } } as any), true);
  });

  it("the delegate switch still wins", () => {
    assert.equal(isSupervisorTool("orch_spawn", undefined, { disabledDelegates: new Set(["orch_spawn"]) }), false);
  });

  it("a stale `capability: full` entry cannot resurrect the removal", () => {
    const branch = [{ type: "custom", customType: "input-supervise-mode:v1", data: { enabled: true, previousTools: [], modeId: "orchestrator", capability: "full" } }];
    const state = superviseModeFromBranch(branch)!;
    assert.equal(state.enabled, true);
    assert.equal((state as any).capability, undefined, "capability must not exist on the parsed state");
    for (const name of ["write", "edit", "browser"]) {
      assert.equal(isSupervisorTool(name), false, `${name} must stay closed for an old full session`);
    }
  });
});

describe("control-plane paths are refused in every request", () => {
  const sessionDir = "/home/u/.pi/agent/sessions/demo";

  it("names the sidecars that bind a session to an outcome", () => {
    for (const path of [
      `${sessionDir}/orchestrator-registry-abc.json`,
      `${sessionDir}/child.jsonl.exit`,
      `${sessionDir}/child.jsonl.exitcode`,
    ]) {
      assert.ok(isControlPlanePath(path, { sessionDir }), `${path} must be control plane`);
    }
  });

  it("refuses anything inside the session state directory", () => {
    assert.ok(isControlPlanePath(`${sessionDir}/artifacts/orchestrator/spec.md`, { sessionDir }));
    assert.ok(isControlPlanePath(`${sessionDir}/child.jsonl`, { sessionDir }));
  });

  it("allows ordinary repository files", () => {
    assert.equal(isControlPlanePath("src/net/retry.ts", { sessionDir }), undefined);
    assert.equal(isControlPlanePath("/tmp/elsewhere/notes.md", { sessionDir }), undefined);
  });
});

describe("evidence references are checked, not quoted", () => {
  it("verifies existence and line bounds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-evidence-"));
    try {
      await writeFile(join(dir, "a.ts"), "one\ntwo\n", "utf8");
      const ok = checkEvidenceRefs([{ kind: "file", path: "a.ts", line: 2 }], { cwd: dir });
      assert.equal(ok.ok, true);
      assert.equal(ok.checked, 1);

      const missing = checkEvidenceRefs([{ kind: "file", path: "nope.ts" }], { cwd: dir });
      assert.equal(missing.ok, false);
      assert.match(missing.problems[0]!, /does not exist/);

      const pastEnd = checkEvidenceRefs([{ kind: "file", path: "a.ts", line: 99 }], { cwd: dir });
      assert.equal(pastEnd.ok, false);
      assert.match(pastEnd.problems[0]!, /past the end/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("requires a command and an exit code, or a named test and a result", () => {
    assert.equal(checkEvidenceRefs([{ kind: "cmd", cmd: "git diff", exit: 0 }], { cwd: "/" }).ok, true);
    assert.equal(checkEvidenceRefs([{ kind: "cmd", cmd: "  ", exit: 0 }], { cwd: "/" }).ok, false);
    assert.equal(checkEvidenceRefs([{ kind: "test", name: "t", pass: false }], { cwd: "/" }).ok, true);
    assert.equal(checkEvidenceRefs(undefined, { cwd: "/" }).checked, 0);
  });

  it("lane matching agrees with the registry's prefix semantics", () => {
    assert.equal(laneCoversPath("src/net/", "src/net/retry.ts"), true);
    assert.equal(laneCoversPath("src/net", "src/net/retry.ts"), true);
    assert.equal(laneCoversPath("src/net/client.ts", "src/net/client.ts"), true);
    assert.equal(laneCoversPath("src/net/client.ts", "src/net/other.ts"), false);
    assert.equal(laneCoversPath("*.md", "docs/README.md"), false, "a bare glob does not cross directories");
    assert.equal(laneCoversPath("**/*.md", "docs/README.md"), true);
  });
});

// ── the review gate ──────────────────────────────────────────────────────────

interface Harness {
  tools: Map<string, any>;
  notices: Array<{ text: string; level: string }>;
  calls: { close: string[] };
  ctx: any;
}

function harness(dir: string): Harness {
  const tools = new Map<string, any>();
  const notices: Harness["notices"] = [];
  const calls = { close: [] as string[] };
  const client: any = {
    paneGet: async (paneId: string) => ({ pane_id: paneId }),
    paneRead: async () => "user@box:~$ ",
    paneList: async () => [],
    paneSendKeys: async () => {},
    paneClose: async (paneId: string) => {
      calls.close.push(paneId);
    },
    paneStart: async () => ({ paneId: "w9:p1" }),
  };
  const ctx: any = {
    cwd: dir,
    ui: { notify: (text: string, level: "info" | "warning" | "error") => notices.push({ text, level }) },
    sessionManager: {
      getBranch: () => [],
      getSessionDir: () => dir,
      getSessionId: () => "parent-capability",
      getSessionFile: () => join(dir, "parent.jsonl"),
    },
  };
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
  orchestratorExtension(pi, {
    client,
    stream: { watch: () => () => {}, onReconcile: () => () => {} },
    now: () => 10_000_000,
    watchdogIntervalMs: 30_000,
  });
  return { tools, notices, calls, ctx };
}

const HANDOFF_LANE = ["src/net/"];

function handoff(scope: string, revision = 1): HandoffRecord {
  return {
    id: `handoff-${scope}`,
    artifactId: `handoff-art-${scope}`,
    scope,
    goal: `do ${scope}`,
    acceptanceCriteria: [`${scope} works`],
    laneFiles: HANDOFF_LANE,
    outOfLaneFiles: [],
    revision,
    authoredAt: new Date(0).toISOString(),
    parentSessionId: "parent-capability",
  } as HandoffRecord;
}

function child(partial: Partial<ScopedChild> = {}): ScopedChild {
  const id = partial.id ?? `cap-${Math.random().toString(16).slice(2, 8)}`;
  return {
    id,
    name: `Worker ${id}`,
    scope: partial.scope ?? "net",
    sessionFile: `/tmp/orchestrator-tests/${id}.jsonl`,
    paneId: `w1:${id}`,
    status: "running",
    laneFiles: HANDOFF_LANE,
    lastMilestoneFiles: [],
    updatedAt: new Date(9_000_000).toISOString(),
    startedAt: 9_000_000,
    budgetMs: 30 * 60_000,
    watchdog: { trip: null, interrupts: 0 },
    frozenCriteria: [`${partial.scope ?? "net"} works`],
    handoffRevision: 1,
    ...partial,
  } as ScopedChild;
}

const VALID = [{ kind: "cmd", cmd: "git diff --stat", exit: 0 }];

function review(tools: Map<string, any>, params: any) {
  return tools.get("orch_review").execute("t", params, undefined, undefined, {}).then((r: any) => r);
}

describe("review gate: evidence, computed lane, independence", () => {
  beforeEach(() => {
    registry.resetForTests();
    handoffs.clear();
    reviewSeams.changedFiles = () => [];
  });

  it("refuses an approval supported only by prose", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-gate-"));
    const h = harness(dir);
    handoffs.set("handoff-net", { record: handoff("net"), path: "/tmp/x.json" });
    registry.registerChild(child({ id: "c-prose", scope: "net" }));
    try {
      const result = await review(h.tools, {
        scope: "net",
        verdict: "approved",
        criteriaNotes: [{ criterion: "net works", evidence: "I read the diff, looks right", passed: true }],
        summary: "trust me",
      });
      assert.equal((result.details as any).error, "evidence-required");
      assert.equal(registry.getChildById("c-prose")!.status, "running", "a refused review settles nothing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a reference it cannot verify", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-gate-"));
    const h = harness(dir);
    handoffs.set("handoff-net", { record: handoff("net"), path: "/tmp/x.json" });
    registry.registerChild(child({ id: "c-missing", scope: "net" }));
    try {
      const result = await review(h.tools, {
        scope: "net",
        verdict: "approved",
        criteriaNotes: [
          { criterion: "net works", evidenceRefs: [{ kind: "file", path: "src/net/does-not-exist.ts" }], passed: true },
        ],
        summary: "verified",
      });
      assert.equal((result.details as any).error, "unverifiable-evidence");
      assert.match((result as any).content[0].text, /could not be verified/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("computes lane compliance and cannot be talked out of a violation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-gate-"));
    const h = harness(dir);
    handoffs.set("handoff-net", { record: handoff("net"), path: "/tmp/x.json" });
    registry.registerChild(child({ id: "c-lane", scope: "net" }));
    reviewSeams.changedFiles = () => ["src/net/retry.ts", "src/auth/jwt.ts"];
    try {
      const result = await review(h.tools, {
        scope: "net",
        verdict: "approved",
        criteriaNotes: [{ criterion: "net works", evidenceRefs: VALID, passed: true }],
        laneCompliance: { inLane: true },
        summary: "inside the lane",
      });
      assert.equal((result.details as any).error, "out-of-lane");
      assert.deepEqual((result.details as any).violations, ["src/auth/jwt.ts"]);
      assert.equal((result.details as any).laneSource, "git");
      assert.match((result as any).content[0].text, /computed from git/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a declaration can tighten but not loosen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-gate-"));
    const h = harness(dir);
    handoffs.set("handoff-net", { record: handoff("net"), path: "/tmp/x.json" });
    registry.registerChild(child({ id: "c-tighten", scope: "net" }));
    try {
      const result = await review(h.tools, {
        scope: "net",
        verdict: "approved",
        criteriaNotes: [{ criterion: "net works", evidenceRefs: VALID, passed: true }],
        laneCompliance: { inLane: false, violations: ["src/net/retry.ts"] },
        summary: "clean diff but I know it is wrong",
      });
      assert.equal((result.details as any).error, "out-of-lane");
      assert.deepEqual((result.details as any).violations, ["src/net/retry.ts"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("an approval the orchestrator authored itself needs the user", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-gate-"));
    const h = harness(dir);
    handoffs.set("handoff-net", { record: handoff("net"), path: "/tmp/x.json" });
    registry.registerChild(child({ id: "c-self", scope: "net" }));
    registry.recordAuthorWrite({ path: "src/net/retry.ts", tool: "edit", at: new Date(10_000_000).toISOString() });
    try {
      const blocked = await review(h.tools, {
        scope: "net",
        verdict: "approved",
        criteriaNotes: [{ criterion: "net works", evidenceRefs: VALID, passed: true }],
        summary: "verified",
      });
      assert.equal((blocked.details as any).error, "confirmation-required");
      assert.equal((blocked.details as any).independence, "self-authored");
      assert.equal(registry.getChildById("c-self")!.status, "running");

      const confirmed = await review(h.tools, {
        scope: "net",
        verdict: "approved",
        criteriaNotes: [{ criterion: "net works", evidenceRefs: VALID, passed: true }],
        summary: "verified, user agreed",
        userConfirmed: true,
      });
      assert.equal((confirmed.details as any).verdict, "approved");
      assert.equal((confirmed.details as any).independence, "self-authored");
      assert.equal((confirmed.details as any).userConfirmed, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a scope whose spec was revised after spawn needs the user, and judges the frozen revision", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-gate-"));
    const h = harness(dir);
    handoffs.set("handoff-net", { record: handoff("net", 2), path: "/tmp/x.json" });
    registry.registerChild(child({ id: "c-revised", scope: "net", handoffRevision: 1 }));
    try {
      const blocked = await review(h.tools, {
        scope: "net",
        verdict: "approved",
        criteriaNotes: [{ criterion: "net works", evidenceRefs: VALID, passed: true }],
        summary: "criteria still hold",
      });
      assert.equal((blocked.details as any).error, "confirmation-required");
      assert.match(JSON.stringify((blocked.details as any).findings), /revision 1/);

      const confirmed = await review(h.tools, {
        scope: "net",
        verdict: "approved",
        criteriaNotes: [{ criterion: "net works", evidenceRefs: VALID, passed: true }],
        summary: "user agreed against the frozen spec",
        userConfirmed: true,
      });
      assert.equal((confirmed.details as any).verdict, "approved");
      assert.equal((confirmed.details as any).specRevision, 1, "the review judged the spec the child was given");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects and revise verdicts stay cheap: no evidence gate, no settling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-gate-"));
    const h = harness(dir);
    handoffs.set("handoff-net", { record: handoff("net"), path: "/tmp/x.json" });
    registry.registerChild(child({ id: "c-revise", scope: "net" }));
    try {
      const result = await review(h.tools, {
        scope: "net",
        verdict: "revise",
        criteriaNotes: [{ criterion: "net works", evidence: "no test covers jitter", passed: false }],
        summary: "add a test",
      });
      assert.equal((result.details as any).verdict, "revise");
      assert.equal(registry.getChildById("c-revise")!.status, "running");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
