import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type ChildDefectReport,
  type ExitSidecarData,
  createChildCorrelation,
  resolveTrustedSourceIdentity,
  validateCompletionReport,
  validateCorrelation,
  validateDefectReport,
  validateExitSidecar,
} from "../../lib/orchestrator/child-messages.ts";
import { writeExitSidecar } from "../../vendor/pi-herdr-subagents/orch-child.ts";
import { buildOutcomeMessage } from "../../vendor/pi-herdr-subagents/src/messages.ts";
import { readChildSessionIdentity } from "../../vendor/pi-herdr-subagents/src/session.ts";
import {
  type RunningSubagent,
  type WatcherDeps,
  watchSubagent,
} from "../../vendor/pi-herdr-subagents/src/watcher.ts";

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-child-msg-test-"));
}

function makeMockDeps(signal: AbortSignal): WatcherDeps {
  return {
    client: {
      paneGet: async () => ({ pane_id: "pane-1", command: "bash", status: "running" }),
      paneRead: async () => null,
      paneList: async () => [{ pane_id: "pane-1", command: "bash", status: "running" }],
    },
    stream: {
      watch: () => () => {},
      onReconcile: () => () => {},
    },
    signal,
    pollIntervalMs: 50,
  };
}

test("validateDefectReport: validates required and optional fields", () => {
  // Minimal valid defect
  const minimal = validateDefectReport({
    expected: "Status should be 200 OK",
    observed: "Received 500 Internal Server Error",
  });
  assert.equal(minimal.ok, true);
  if (minimal.ok) {
    assert.equal(minimal.value.expected, "Status should be 200 OK");
    assert.equal(minimal.value.observed, "Received 500 Internal Server Error");
    assert.equal(minimal.value.severity, undefined);
  }

  // Full valid defect
  const full = validateDefectReport({
    scope: "auth-service",
    criterionId: "AC-1",
    file: "src/auth/token.ts",
    line: 42,
    expected: "token has expiry",
    observed: "token never expires",
    severity: "blocker",
  });
  assert.equal(full.ok, true);
  if (full.ok) {
    assert.equal(full.value.scope, "auth-service");
    assert.equal(full.value.criterionId, "AC-1");
    assert.equal(full.value.file, "src/auth/token.ts");
    assert.equal(full.value.line, 42);
    assert.equal(full.value.severity, "blocker");
  }
});

test("validateDefectReport: rejects invalid, missing, or oversized inputs", () => {
  // Not an object
  assert.equal(validateDefectReport("not an object").ok, false);
  assert.equal(validateDefectReport(null).ok, false);
  assert.equal(validateDefectReport([]).ok, false);

  // Missing expected
  assert.equal(validateDefectReport({ observed: "something broke" }).ok, false);

  // Missing observed
  assert.equal(validateDefectReport({ expected: "something worked" }).ok, false);

  // Empty expected or observed
  assert.equal(validateDefectReport({ expected: "  ", observed: "broken" }).ok, false);
  assert.equal(validateDefectReport({ expected: "working", observed: "" }).ok, false);

  // Oversized expected
  assert.equal(
    validateDefectReport({
      expected: "x".repeat(4001),
      observed: "broke",
    }).ok,
    false,
  );

  // Oversized observed
  assert.equal(
    validateDefectReport({
      expected: "work",
      observed: "y".repeat(4001),
    }).ok,
    false,
  );

  // Invalid line numbers
  assert.equal(
    validateDefectReport({ expected: "a", observed: "b", line: 0 }).ok,
    false,
  );
  assert.equal(
    validateDefectReport({ expected: "a", observed: "b", line: -5 }).ok,
    false,
  );
  assert.equal(
    validateDefectReport({ expected: "a", observed: "b", line: 1.5 }).ok,
    false,
  );
  assert.equal(
    validateDefectReport({ expected: "a", observed: "b", line: "42" as any }).ok,
    false,
  );

  // Invalid severity
  assert.equal(
    validateDefectReport({ expected: "a", observed: "b", severity: "critical" as any }).ok,
    false,
  );
});

test("validateDefectReport: rejects caller-supplied identity claims ('from' / 'caller')", () => {
  const forged = validateDefectReport({
    from: "impersonated-agent",
    expected: "should pass",
    observed: "failed",
  });
  assert.equal(forged.ok, false);
  if (!forged.ok) {
    assert.match(forged.error, /source identity is derived from trusted session\/env/);
  }
});

test("validateCompletionReport: validates status, filesTouched, and criteriaNotes", () => {
  const valid = validateCompletionReport({
    status: "ok",
    filesTouched: ["src/a.ts", "src/b.ts"],
    criteriaNotes: [
      { criterion: "AC-1", passed: true, evidence: "tests passed" },
      { criterion: "AC-2", passed: false },
    ],
  });
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.value.status, "ok");
    assert.deepEqual(valid.value.filesTouched, ["src/a.ts", "src/b.ts"]);
    assert.equal(valid.value.criteriaNotes?.length, 2);
  }

  // Rejects invalid status
  assert.equal(validateCompletionReport({ status: "unknown" as any }).ok, false);

  // Rejects invalid criteria item
  assert.equal(
    validateCompletionReport({
      criteriaNotes: [{ criterion: "AC-1" } as any], // missing 'passed'
    }).ok,
    false,
  );

  // Rejects caller-supplied from
  assert.equal(validateCompletionReport({ from: "spoofed" }).ok, false);
});

test("validateCorrelation: validates messageId, replyTo, runId, attempt", () => {
  const valid = validateCorrelation({
    messageId: "msg-123",
    replyTo: "steer-456",
    runId: "run-789",
    attempt: 2,
  });
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.value.messageId, "msg-123");
    assert.equal(valid.value.replyTo, "steer-456");
    assert.equal(valid.value.runId, "run-789");
    assert.equal(valid.value.attempt, 2);
  }

  // Missing messageId
  assert.equal(validateCorrelation({}).ok, false);

  // Invalid attempt
  assert.equal(validateCorrelation({ messageId: "msg-1", attempt: 0 }).ok, false);
  assert.equal(validateCorrelation({ messageId: "msg-1", attempt: -1 }).ok, false);
});

test("validateExitSidecar: preserves legacy sidecars and detects typed ones", () => {
  // Legacy done
  const legacyDone = validateExitSidecar({ type: "done" });
  assert.equal(legacyDone.ok, true);
  if (legacyDone.ok) {
    assert.equal(legacyDone.isLegacy, true);
    assert.equal(legacyDone.value.type, "done");
  }

  // Legacy ping
  const legacyPing = validateExitSidecar({
    type: "ping",
    name: "worker",
    message: "Need help with X",
  });
  assert.equal(legacyPing.ok, true);
  if (legacyPing.ok) {
    assert.equal(legacyPing.isLegacy, true);
    assert.equal(legacyPing.value.type, "ping");
  }

  // Typed defect ping
  const typedPing = validateExitSidecar({
    type: "ping",
    name: "worker",
    message: "Defect found",
    defect: {
      expected: "200 OK",
      observed: "500 Error",
    },
    correlation: { messageId: "msg-1" },
  });
  assert.equal(typedPing.ok, true);
  if (typedPing.ok) {
    assert.equal(typedPing.isLegacy, false);
    assert.equal(typedPing.value.type, "ping");
    assert.equal((typedPing.value as any).defect?.expected, "200 OK");
  }

  // Defect not allowed on done
  const defectOnDone = validateExitSidecar({
    type: "done",
    defect: { expected: "a", observed: "b" },
  });
  assert.equal(defectOnDone.ok, false);

  // Invalid defect payload is rejected, NOT silently downgraded
  const invalidDefectPing = validateExitSidecar({
    type: "ping",
    name: "worker",
    message: "Help",
    defect: { expected: 123 }, // invalid expected
  });
  assert.equal(invalidDefectPing.ok, false);
});

test("writeExitSidecar: preserves exact byte-shape for legacy payloads", () => {
  const dir = createTmpDir();
  try {
    const sessionFile = join(dir, "child.jsonl");

    // Legacy done byte shape
    writeExitSidecar(sessionFile, { type: "done" });
    const doneText = readFileSync(`${sessionFile}.exit`, "utf8");
    assert.equal(doneText, '{"type":"done"}');

    // Legacy ping byte shape
    writeExitSidecar(sessionFile, { type: "ping", name: "agent-1", message: "help please" });
    const pingText = readFileSync(`${sessionFile}.exit`, "utf8");
    assert.equal(pingText, '{"type":"ping","name":"agent-1","message":"help please"}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createChildCorrelation and resolveTrustedSourceIdentity", () => {
  const corr = createChildCorrelation({ replyTo: "prev-1", attempt: 1, runId: "r-99" });
  assert.match(corr.messageId, /^msg-/);
  assert.equal(corr.replyTo, "prev-1");
  assert.equal(corr.attempt, 1);
  assert.equal(corr.runId, "r-99");

  const identity = resolveTrustedSourceIdentity({
    PI_SUBAGENT_ID: "child-abc",
    PI_SUBAGENT_SCOPE: "auth-lane",
    PI_SUBAGENT_NAME: "Auth Worker",
    PI_SUBAGENT_SESSION: "/path/to/session.jsonl",
  });
  assert.deepEqual(identity, {
    childId: "child-abc",
    scope: "auth-lane",
    name: "Auth Worker",
    sessionFile: "/path/to/session.jsonl",
  });

  // Missing session or ID returns null
  assert.equal(resolveTrustedSourceIdentity({}), null);
});

test("readChildSessionIdentity: reads session header reliably from file", () => {
  const dir = createTmpDir();
  try {
    const sessionFile = join(dir, "child.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: "uuid-12345",
      parentSession: "/tmp/parent.jsonl",
      cwd: "/repo",
    };
    writeFileSync(sessionFile, JSON.stringify(header) + "\n", "utf8");

    const parsed = readChildSessionIdentity(sessionFile);
    assert.equal(parsed.sessionId, "uuid-12345");
    assert.equal(parsed.parentSession, "/tmp/parent.jsonl");
    assert.equal(parsed.cwd, "/repo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watchSubagent: end-to-end typed defect survives sidecar to outcome without prose parsing", async () => {
  const dir = createTmpDir();
  try {
    const sessionFile = join(dir, "test-session.jsonl");
    writeFileSync(sessionFile, '{"type":"session","version":3,"id":"s1"}\n', "utf8");

    const running: RunningSubagent = {
      id: "run-42",
      name: "auth-worker",
      task: "fix auth defect",
      paneId: "pane-1",
      startTime: Date.now(),
      sessionFile,
      launchScriptFile: join(dir, "launch.sh"),
      interactive: false,
      autoExit: true,
      scope: "auth-scope",
    };

    const defect: ChildDefectReport = {
      scope: "auth-scope",
      criterionId: "AC-3",
      file: "src/auth/jwt.ts",
      line: 88,
      expected: "JWT signature verified",
      observed: "JWT verification throws UnhandledPromiseRejection",
      severity: "blocker",
    };

    const payload: ExitSidecarData = {
      type: "ping",
      name: "auth-worker",
      message: "Blocking defect in jwt verification",
      defect,
      correlation: { messageId: "msg-101", runId: "run-42" },
      runId: "run-42",
      schemaVersion: 1,
    };

    writeExitSidecar(sessionFile, payload);

    const controller = new AbortController();
    const outcome = await watchSubagent(running, makeMockDeps(controller.signal));

    assert.equal(outcome.kind, "ping");
    if (outcome.kind === "ping") {
      assert.equal(outcome.name, "auth-worker");
      assert.equal(outcome.message, "Blocking defect in jwt verification");
      assert.deepEqual(outcome.defect, defect);
      assert.equal(outcome.correlation?.messageId, "msg-101");
      // Verified: source identity derived from authoritative running record, NOT untrusted payload
      assert.deepEqual(outcome.sourceIdentity, {
        childId: "run-42",
        scope: "auth-scope",
        name: "auth-worker",
        sessionFile,
      });
      assert.equal(outcome.validationError, undefined);
    }

    // Verify buildOutcomeMessage carries typed defect in details
    const msg = buildOutcomeMessage(running, outcome);
    assert.ok(msg);
    assert.equal(msg.customType, "subagent_ping");
    assert.deepEqual(msg.details.defect, defect);
    assert.deepEqual(msg.details.sourceIdentity, {
      childId: "run-42",
      scope: "auth-scope",
      name: "auth-worker",
      sessionFile,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watchSubagent: invalid typed payload is rejected rather than silently downgraded", async () => {
  const dir = createTmpDir();
  try {
    const sessionFile = join(dir, "test-session.jsonl");
    writeFileSync(sessionFile, '{"type":"session","version":3,"id":"s1"}\n', "utf8");

    const running: RunningSubagent = {
      id: "run-43",
      name: "worker",
      task: "task",
      paneId: "pane-1",
      startTime: Date.now(),
      sessionFile,
      launchScriptFile: join(dir, "launch.sh"),
      interactive: false,
      autoExit: true,
      scope: "some-scope",
    };

    // Defect missing required 'observed' field
    const invalidPayload = {
      type: "ping",
      name: "worker",
      message: "Help",
      defect: { expected: "something" },
      runId: "run-43",
    };

    writeFileSync(`${sessionFile}.exit`, JSON.stringify(invalidPayload), "utf8");

    const controller = new AbortController();
    const outcome = await watchSubagent(running, makeMockDeps(controller.signal));

    assert.equal(outcome.kind, "ping");
    if (outcome.kind === "ping") {
      // Must NOT silently downgrade by ignoring the defect: validationError is flagged
      assert.ok(outcome.validationError);
      assert.match(outcome.validationError, /observed/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watchSubagent: stale sidecar from previous run on resumed session is ignored and removed", async () => {
  const dir = createTmpDir();
  try {
    const sessionFile = join(dir, "test-session.jsonl");
    writeFileSync(sessionFile, '{"type":"session","version":3,"id":"s1"}\n', "utf8");

    const running: RunningSubagent = {
      id: "run-new",
      name: "worker",
      task: "task",
      paneId: "pane-1",
      startTime: Date.now(),
      sessionFile,
      launchScriptFile: join(dir, "launch.sh"),
      interactive: false,
      autoExit: true,
    };

    // Leftover sidecar from "run-old"
    const stalePayload = {
      type: "done",
      runId: "run-old",
    };
    writeFileSync(`${sessionFile}.exit`, JSON.stringify(stalePayload), "utf8");

    const controller = new AbortController();
    const deps = makeMockDeps(controller.signal);

    // Watch promise begins while stale sidecar is on disk
    const watchPromise = watchSubagent(running, deps);

    // Give watcher microtask time to classify and discard stale sidecar
    await new Promise((r) => setTimeout(r, 60));

    // Now write the legitimate sidecar for "run-new"
    writeExitSidecar(sessionFile, {
      type: "done",
      runId: "run-new",
      report: { status: "ok" },
    });

    const outcome = await watchPromise;
    assert.equal(outcome.kind, "completed");
    if (outcome.kind === "completed") {
      assert.equal(outcome.report?.status, "ok");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
