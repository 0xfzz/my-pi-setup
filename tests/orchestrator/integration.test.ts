import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sanitizeScope,
  writeWorkSpec,
  getSpecFilePath,
  getSpecDeliveryDir,
  parseSpecLaneFiles,
} from "../../lib/orchestrator/artifact-scope.ts";
import { ScopeRegistry } from "../../lib/orchestrator/scope-registry.ts";
import { routeUpdate, matchOwner } from "../../lib/orchestrator/steer-router.ts";
import { isSupervisorTool, SUPERVISOR_TOOLS } from "../../lib/supervise-mode.ts";
import {
  applyVersionToggle,
  parseSubagentsCommand,
  saveSubagentVersion,
  getSubagentVersionStatus,
} from "../../lib/version-switch.ts";
import {
  visibleToScope,
  type Artifact,
} from "../../lib/artifact-state.ts";

test("Integration: v1 backward-compatibility — undefined scope treated as global", () => {
  const globalArt: Artifact = {
    id: "vision",
    title: "Project Vision",
    type: "plan",
    content: "Global vision",
    createdBy: "main",
    tags: [],
    version: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };

  const scopedArtA: Artifact = {
    id: "net.spec",
    title: "Net Spec",
    type: "spec",
    scope: "net-layer",
    content: "Net lane specs",
    createdBy: "main",
    tags: [],
    version: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };

  // v1 child has scope === undefined: sees global artifacts, does NOT see scoped artifacts
  assert.equal(visibleToScope(globalArt, undefined), true, "global artifact visible to v1");
  assert.equal(visibleToScope(scopedArtA, undefined), false, "scoped artifact not leaked to v1");

  // v2 child scoped to net-layer: sees global and net-layer
  assert.equal(visibleToScope(globalArt, "net-layer"), true, "global artifact visible to v2");
  assert.equal(visibleToScope(scopedArtA, "net-layer"), true, "net-layer spec visible to net-layer child");

  // Sibling child scoped to ui-layer: does NOT see net-layer
  assert.equal(visibleToScope(scopedArtA, "ui-layer"), false, "net-layer spec hidden from sibling");
});

test("Integration: Scoped spec handoff and directory security permissions", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "sv2-integ-specs-"));
  try {
    const parentSessionId = "session-parent-123";
    const runId = "run-child-456";
    const scope = "storage-engine";

    const deliveryDir = getSpecDeliveryDir(baseDir, parentSessionId, runId);
    assert.ok(deliveryDir.includes("session-parent-123/run-child-456"));

    const specPath = writeWorkSpec(
      baseDir,
      parentSessionId,
      runId,
      {
        scope,
        laneFiles: ["src/storage/engine.ts", "src/storage/wal.ts"],
        acceptanceCriteria: ["Implement append-only WAL", "Pass zero-loss recovery test"],
      }
    );

    assert.equal(specPath, getSpecFilePath(baseDir, parentSessionId, runId, scope));
    const content = await readFile(specPath, "utf-8");
    // Canonical handoff heading: the audit copy and the child ticket are the same
    // document, so this is the single contract both must satisfy.
    assert.match(content, /# Work handoff: storage-engine/);
    assert.match(content, /src\/storage\/engine\.ts/);
    assert.match(content, /src\/storage\/wal\.ts/);
    assert.match(content, /Implement append-only WAL/);
    // Every handoff carries both escalation routes.
    assert.match(content, /orch_ping/);
    assert.match(content, /escalates to the user/);

    const laneFiles = parseSpecLaneFiles(content);
    assert.deepEqual(laneFiles, ["src/storage/engine.ts", "src/storage/wal.ts"]);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("Integration: Version toggles session state and settings persistence", async () => {
  const allTools = [
    "read", "write", "edit", "bash",
    "subagent", "subagent_resume", "subagent_interrupt",
    "orch_spawn", "orch_resume", "orch_interrupt", "orch_steer", "orch_route", "orch_running", "orch_review",
  ];

  let activeTools = new Set(allTools);

  const fakePi = {
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools: string[]) => {
      activeTools = new Set(tools);
    },
    getAllTools: () => allTools.map((name) => ({ name })),
  };

  // The switch is a decision, not a loadout diff. The real caller persists
  // `disabled` on the branch and threads it back in, which is what makes the
  // toggle reversible even after a restricted mode narrowed the live loadout.
  let disabled: string[] = [];
  const toggle = (action: Parameters<typeof applyVersionToggle>[1]) => {
    const result = applyVersionToggle(fakePi, action, disabled);
    disabled = result.disabled;
    return result;
  };

  // Turn v1 off
  toggle("v1-off");
  assert.ok(!activeTools.has("subagent"), "v1 tools must be disabled");
  assert.ok(activeTools.has("orch_spawn"), "v2 tools remain active");
  assert.ok(activeTools.has("read"), "standard tools unaffected");
  // Regression: nothing outside the delegate lists is ever removed.
  for (const tool of ["read", "write", "edit", "bash"]) {
    assert.ok(activeTools.has(tool), `${tool} must survive the v1 switch`);
  }

  // Turn v2 off
  toggle("v2-off");
  assert.ok(!activeTools.has("orch_spawn"), "v2 tools must be disabled");

  // Turn v2 only on
  toggle("v2-only");
  assert.ok(activeTools.has("orch_spawn"), "v2 tools restored");
  assert.ok(!activeTools.has("subagent"), "v1 tools stay inactive in v2 only mode");

  // Check status reporting
  const status = getSubagentVersionStatus(fakePi);
  assert.equal(status.v1Active, false);
  assert.equal(status.v2Active, true);

  // `all on` is the reset: both surfaces come back, nothing else changes.
  toggle("all-on");
  assert.deepEqual(disabled, []);
  for (const tool of ["subagent", "orch_spawn"]) {
    assert.ok(activeTools.has(tool), `${tool} restored by all-on`);
  }
  const reset = getSubagentVersionStatus(fakePi);
  assert.equal(reset.v1Active, true);
  assert.equal(reset.v2Active, true);

  // Persist to settings.json
  const tmpDir = await mkdtemp(join(tmpdir(), "sv2-integ-settings-"));
  try {
    const settingsPath = join(tmpDir, "settings.json");
    saveSubagentVersion("v2", settingsPath);
    const raw = JSON.parse(await readFile(settingsPath, "utf-8"));
    assert.equal(raw.subagentVersion, "v2");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Integration: End-to-end steering router resolution across all conditions", async () => {
  const registry = new ScopeRegistry();
  const injectedCalls: any[] = [];

  const fakeClient: any = {
    paneSendKeys: async (paneId: string, keys: string[]) => {
      injectedCalls.push({ type: "keys", paneId, keys });
    },
    paneSendText: async (paneId: string, text: string) => {
      injectedCalls.push({ type: "text", paneId, text });
    },
    // Herdr's real contract: visible pane text, or null when the pane is gone.
    paneRead: async (_paneId: string) => "user@box:~$ ",
  };

  registry.registerChild({
    id: "child-worker-1",
    name: "Worker 1 (Network)",
    scope: "network",
    sessionFile: "/tmp/net.jsonl",
    paneId: "pane-net",
    status: "running",
    specPath: "/tmp/network.spec.md",
    laneFiles: ["src/net/client.ts", "src/net/retry.ts"],
    lastMilestoneFiles: ["src/net/client.ts"],
    pendingPing: false,
    updatedAt: new Date(0).toISOString(),
  });

  registry.registerChild({
    id: "child-worker-2",
    name: "Worker 2 (DB)",
    scope: "database",
    sessionFile: "/tmp/db.jsonl",
    paneId: "pane-db",
    status: "running",
    specPath: "/tmp/database.spec.md",
    laneFiles: ["src/db/pool.ts", "src/db/migrate.ts"],
    lastMilestoneFiles: ["src/db/pool.ts"],
    pendingPing: false,
    updatedAt: new Date(0).toISOString(),
  });

  // 1. User steer on lane file -> resolved to Worker 1, mode: interrupt
  const userSteer = await routeUpdate(
    registry,
    {
      update: "Change timeout in src/net/retry.ts to 5000ms",
      origin: "user",
      apply: true,
    },
    fakeClient
  );

  assert.equal(userSteer.outcome, "interrupt");
  assert.equal(userSteer.target?.id, "child-worker-1");
  assert.equal(userSteer.evidence?.level, "L2");

  // Verify interrupt protocol sequence: esc -> sendText -> enter (herdr key syntax)
  assert.equal(injectedCalls[0].type, "keys");
  assert.deepEqual(injectedCalls[0].keys, ["esc"]);
  assert.equal(injectedCalls[1].type, "text");
  assert.ok(injectedCalls[1].text.includes("Change timeout"));
  assert.equal(injectedCalls[2].type, "keys");
  assert.deepEqual(injectedCalls[2].keys, ["enter"]);

  // 2. Orchestrator steer within scope -> resolved to Worker 2, mode: queue (no esc)
  injectedCalls.length = 0;
  const orchSteer = await routeUpdate(
    registry,
    {
      update: "Please add index on user_id in database",
      origin: "orchestrator",
      scope: "database",
      apply: true,
    },
    fakeClient
  );

  assert.equal(orchSteer.outcome, "queue");
  assert.equal(orchSteer.target?.id, "child-worker-2");
  // No Escape key injected for orchestrator queue
  assert.equal(injectedCalls.some((c: any) => c.keys?.includes("esc")), false);
  assert.equal(injectedCalls[0].type, "text");
  assert.equal(injectedCalls[1].type, "keys");
  assert.deepEqual(injectedCalls[1].keys, ["enter"]);

  // 3. Orchestrator attempting cross-scope redirect -> refused (D6)
  const forbiddenRedirect = await routeUpdate(
    registry,
    {
      update: "Switch database task to work on src/net/client.ts",
      id: "child-worker-2",
      origin: "orchestrator",
      scope: "network",
      apply: true,
    },
    fakeClient
  );
  assert.equal(forbiddenRedirect.outcome, "unauthorized");
  assert.match(forbiddenRedirect.reason, /across scopes/);

  // 4. Ambiguous (touches both lanes or multiple candidates) -> no automatic action
  injectedCalls.length = 0;
  const ambiguousSteer = await routeUpdate(
    registry,
    {
      update: "Check both src/net/client.ts and src/db/pool.ts",
      origin: "user",
      apply: true,
    },
    fakeClient
  );
  assert.equal(ambiguousSteer.outcome, "ambiguous");
  assert.equal(injectedCalls.length, 0, "ambiguous must never inject keystrokes");

  // 5. Nonexistent -> returns 4 intent questions
  const nonexistentSteer = await routeUpdate(
    registry,
    {
      update: "Update CSS color in frontend styling styles.css",
      origin: "user",
      apply: true,
    },
    fakeClient
  );
  assert.equal(nonexistentSteer.outcome, "nonexistent");
  assert.equal(nonexistentSteer.inventory!.length, 2);
  assert.equal(nonexistentSteer.questions!.length, 4);
});

test("Integration: Supervise mode restrictions and orchestrator boundary", () => {
  // Disallowed implementation tools
  for (const tool of ["edit", "write", "browser", "browser_login", "mcp", "codemode"]) {
    assert.equal(isSupervisorTool(tool), false, `${tool} must be blocked in supervise mode`);
  }

  // Allowed delegation, routing, and inspection tools
  for (const tool of [
    "orch_spawn", "orch_resume", "orch_interrupt", "orch_steer", "orch_route", "orch_running", "orch_review",
    "read", "grep", "find", "ls", "ffgrep", "fffind", "artifact_save", "artifact_recall", "workflow_todo",
  ]) {
    assert.equal(isSupervisorTool(tool), true, `${tool} must be allowed in supervise mode`);
  }
});
