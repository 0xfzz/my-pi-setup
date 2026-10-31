import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGate, type AskAnswer, type GateDeps } from "../lib/scope/gate.ts";
import { parseScopeCommand } from "../lib/scope/command.ts";
import {
  DEFAULT_MAX_BYTES,
  defaultTelemetryPath,
  formatTelemetrySummary,
  readTelemetryRecords,
  sanitizeTelemetryText,
  ScopeTelemetry,
  summarizeTelemetry,
  TELEMETRY_VERSION,
  telemetryEnabled,
  type DecisionRecord,
  type StoredDecisionRecord,
} from "../lib/scope/telemetry.ts";
import { DEFAULT_SCOPE_DEFAULTS, type ScopeState } from "../lib/scope/types.ts";

const cwd = "/work";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "scope-telemetry-"));
}

function lines(path: string): StoredDecisionRecord[] {
  return readTelemetryRecords(path);
}

const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  tool: "read",
  input: "src/a.ts",
  cwd,
  effect: "allow",
  asked: false,
  reason: "inside the workspace",
  ...over,
});

// ---- the writer -------------------------------------------------------------

test("a record is one JSON line carrying the schema version", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "scope-telemetry.jsonl");
    new ScopeTelemetry({ path }).record(record());
    const [stored] = lines(path);
    assert.equal(stored?.v, TELEMETRY_VERSION);
    assert.equal(typeof stored?.at, "number");
    assert.equal(stored?.tool, "read");
    assert.equal(stored?.asked, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the sink creates a missing directory instead of failing", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "nested", "deeper", "scope-telemetry.jsonl");
    new ScopeTelemetry({ path }).record(record());
    assert.equal(lines(path).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("telemetry is off when disabled, and writes nothing", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "scope-telemetry.jsonl");
    new ScopeTelemetry({ path, enabled: false }).record(record());
    await assert.rejects(stat(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unwritable destination is swallowed, not thrown", async () => {
  const dir = await tempDir();
  try {
    // A file where the directory should be makes mkdirSync fail with ENOTDIR.
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory");
    assert.doesNotThrow(() => new ScopeTelemetry({ path: join(blocker, "scope-telemetry.jsonl") }).record(record()));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the file rotates at the threshold and keeps one predecessor", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "scope-telemetry.jsonl");
    const sink = new ScopeTelemetry({ path, maxBytes: 1024 });
    for (let index = 0; index < 40; index++) sink.record(record({ input: `src/file-${index}.ts` }));
    const current = lines(path);
    const previous = lines(`${path}.1`);
    assert.ok(current.length > 0, "the current file keeps the newest records");
    assert.ok(previous.length > 0, "the rotated file is kept for analysis");
    assert.ok((await stat(path)).size <= 1024 + 512, "rotation happens before the file stretches a record past the threshold");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rotation covers a file that already existed before the sink started", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "scope-telemetry.jsonl");
    await writeFile(path, `${JSON.stringify({ ...record({ input: "old" }), v: 1, at: 1 })}\n`.repeat(30));
    new ScopeTelemetry({ path, maxBytes: 1024 }).record(record({ input: "new" }));
    assert.equal(lines(path).length, 1, "the oversized predecessor is rotated out");
    assert.equal(lines(`${path}.1`).length, 30);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- sanitizing -------------------------------------------------------------

test("command text is truncated so one call cannot fill the file", () => {
  const long = "x".repeat(DEFAULT_MAX_BYTES);
  const text = sanitizeTelemetryText(long, 20);
  assert.equal(text.slice(0, 20), "x".repeat(20));
  assert.match(text, new RegExp(`\\+${long.length - 20} chars`));
});

test("credential-shaped values are redacted before they reach disk", () => {
  assert.equal(sanitizeTelemetryText("curl -H 'Authorization: Bearer abc.def'"), "curl -H 'Authorization: [redacted]'");
  assert.equal(sanitizeTelemetryText("API_KEY=sk-live-123 ./run.sh"), "API_KEY=[redacted] ./run.sh");
  assert.equal(sanitizeTelemetryText("tool --token hunter2 --verbose"), "tool --token [redacted] --verbose");
  assert.equal(sanitizeTelemetryText("echo plain text"), "echo plain text");
});

test("redaction is applied to the stored record, not only to the helper", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "scope-telemetry.jsonl");
    new ScopeTelemetry({ path }).record(record({ input: "TOKEN=abc123 cmd", reason: "denied for SECRET=xyz" }));
    const [stored] = lines(path);
    assert.equal(stored?.input, "TOKEN=[redacted] cmd");
    assert.equal(stored?.reason, "denied for SECRET=[redacted]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the environment switch and path are read once, with a usable default", () => {
  assert.equal(telemetryEnabled({}), true);
  assert.equal(telemetryEnabled({ PI_SCOPE_TELEMETRY: "off" }), false);
  assert.equal(telemetryEnabled({ PI_SCOPE_TELEMETRY: "FALSE" }), false);
  assert.equal(telemetryEnabled({ PI_SCOPE_TELEMETRY: "on" }), true);
  assert.equal(defaultTelemetryPath({ PI_SCOPE_TELEMETRY_FILE: "/tmp/x.jsonl" }), "/tmp/x.jsonl");
  assert.equal(
    defaultTelemetryPath({ PI_CODING_AGENT_DIR: "/agent" }),
    join("/agent", "scope-telemetry.jsonl"),
  );
  // One global log, never a per-workspace one: no cwd or project segment leaks in.
  assert.match(defaultTelemetryPath({}), /[\\/]\.pi[\\/]agent[\\/]scope-telemetry\.jsonl$/);
});

// ---- the gate ---------------------------------------------------------------

function harness(script: Array<AskAnswer | undefined> = [], extra: Partial<GateDeps> = {}) {
  const records: DecisionRecord[] = [];
  const state: ScopeState = {
    roots: [{ path: cwd, access: "rw", source: "session" }],
    rules: [],
    defaults: { ...DEFAULT_SCOPE_DEFAULTS },
  };
  const gate = createGate({
    cwd: () => cwd,
    state: () => state,
    setState: () => {},
    ask: async () => script.shift(),
    onDecision: entry => records.push(entry),
    ...extra,
  });
  return { gate, records };
}

test("an internal allow is recorded, so the log is not only exceptions", async () => {
  const h = harness();
  assert.equal(await h.gate.gate("read", { path: "src/a.ts" }), undefined);
  assert.equal(h.records.length, 1);
  const [entry] = h.records;
  assert.equal(entry?.effect, "allow");
  assert.equal(entry?.asked, false);
  assert.equal(entry?.input, "src/a.ts");
  assert.equal(entry?.claim?.absolute, "/work/src/a.ts");
  assert.equal(entry?.state?.roots, 1);
});

test("an outside write records the question and the answer that resolved it", async () => {
  const h = harness([{ kind: "once" }]);
  assert.equal(await h.gate.gate("write", { path: "../other/a.ts" }), undefined);
  assert.equal(h.records.length, 1);
  const [entry] = h.records;
  assert.equal(entry?.effect, "allow");
  assert.equal(entry?.asked, true);
  assert.equal(entry?.answer, "once");
  assert.equal(entry?.claim?.external, true);
  assert.match(entry?.reason ?? "", /outside the workspace/);
});

test("a denial records the effect and the matched rule", async () => {
  const h = harness([], {
    state: () => ({
      roots: [{ path: cwd, access: "rw", source: "session" }],
      rules: [{ action: "read", resource: "*secret*", effect: "deny", source: "project" }],
      defaults: { ...DEFAULT_SCOPE_DEFAULTS },
    }),
  });
  const result = await h.gate.gate("read", { path: "/etc/secret.txt" });
  assert.equal(result?.block, true);
  const [entry] = h.records;
  assert.equal(entry?.effect, "deny");
  assert.equal(entry?.rule?.action, "read");
  assert.equal(entry?.rule?.source, "project");
});

test("an unreadable command is recorded as an opaque detection gap", async () => {
  const h = harness([{ kind: "deny" }]);
  const result = await h.gate.gate("bash", { command: "bash -c 'cat /etc/passwd'" });
  assert.equal(result?.block, true);
  const [entry] = h.records;
  assert.equal(entry?.unknown, true);
  assert.match(entry?.opaque ?? "", /inline code/);
  assert.equal(entry?.asked, true);
  assert.equal(entry?.input, "bash -c 'cat /etc/passwd'");
});

test("a yolo approval is recorded as automatic, with the strength", async () => {
  const h = harness([], { state: () => ({ roots: [{ path: cwd, access: "rw", source: "session" }], rules: [], defaults: { external: "ask", readExternal: "allow" }, yolo: { strength: "rw", persist: false, since: 0 } }) });
  assert.equal(await h.gate.gate("write", { path: "../other/a.ts" }), undefined);
  const [entry] = h.records;
  assert.equal(entry?.effect, "allow");
  assert.equal(entry?.auto, true);
  assert.equal(entry?.yolo, "rw");
  assert.equal(entry?.state?.yolo, "rw");
});

test("a throwing sink cannot change a verdict", async () => {
  const h = harness([], { onDecision: () => { throw new Error("sink broke"); } });
  assert.equal(await h.gate.gate("read", { path: "src/a.ts" }), undefined);
  const blocked = await h.gate.gate("write", { path: "../other/a.ts" });
  assert.equal(blocked?.block, true, "the gate still decides exactly as it would without telemetry");
});

// ---- reading and summarizing ------------------------------------------------

test("a missing log reads as empty instead of throwing", () => {
  assert.deepEqual(readTelemetryRecords("/nonexistent/scope-telemetry.jsonl"), []);
});

test("the reader skips corrupt lines and keeps the newest limit", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "scope-telemetry.jsonl");
    const line = (tool: string) => JSON.stringify({ ...record({ tool }), v: 1, at: 1 });
    await writeFile(path, [line("read"), "{not json", line("write"), line("bash")].join("\n"));
    assert.deepEqual(readTelemetryRecords(path).map(entry => entry.tool), ["read", "write", "bash"]);
    assert.deepEqual(readTelemetryRecords(path, 2).map(entry => entry.tool), ["write", "bash"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the summary counts the targets that ask, the gaps and the rules that fired", () => {
  const rows: DecisionRecord[] = [
    record({ asked: true, answer: "once", effect: "allow", claim: { action: "read", absolute: "/srv/data", resource: "/srv/data", write: false, posture: "read", external: true, kind: "directory" } }),
    record({ asked: true, answer: "once", effect: "allow", claim: { action: "read", absolute: "/srv/data", resource: "/srv/data", write: false, posture: "read", external: true, kind: "directory" } }),
    record({ asked: true, answer: "deny", effect: "deny", claim: { action: "read", absolute: "/srv/data", resource: "/srv/data", write: false, posture: "read", external: true, kind: "directory" } }),
    record({ tool: "bash", input: "bash -c id", unknown: true, opaque: "bash -c", asked: true, answer: "deny", effect: "deny" }),
    record({ tool: "read", input: "/etc/secret", effect: "deny", rule: { action: "read", resource: "*secret*", effect: "deny" } }),
    record({ cwd: "/other", auto: true, effect: "allow", yolo: "ro" }),
  ];
  const summary = summarizeTelemetry(rows);
  assert.equal(summary.total, 6);
  assert.equal(summary.workspaces, 2, "the global log spans workspaces");
  assert.equal(summary.asked, 4);
  assert.equal(summary.denied, 3);
  assert.equal(summary.automatic, 1);
  assert.equal(summary.unknown, 1);
  assert.deepEqual(summary.askedTargets[0], { target: "/srv/data", count: 3, once: 2, denied: 1 });
  assert.deepEqual(summary.repeats, [{ target: "/srv/data", count: 3, once: 2, denied: 1 }]);
  assert.deepEqual(summary.gaps, [{ construct: "bash -c", count: 1, tools: ["bash"] }]);
  assert.deepEqual(summary.deniedRules, [{ rule: "read:*secret*", count: 1 }]);
});

test("the summary renders empty and populated states", () => {
  assert.match(formatTelemetrySummary(summarizeTelemetry([]), "/tmp/t.jsonl").join("\n"), /no records yet in \/tmp\/t\.jsonl/);
  const lines = formatTelemetrySummary(
    summarizeTelemetry([
      record({ asked: true, answer: "once", effect: "allow", claim: { action: "read", absolute: "/srv", resource: "/srv", write: false, posture: "read", external: true, kind: "directory" } }),
      record({ asked: true, answer: "once", effect: "allow", claim: { action: "read", absolute: "/srv", resource: "/srv", write: false, posture: "read", external: true, kind: "directory" } }),
    ]),
    "/tmp/t.jsonl",
  ).join("\n");
  assert.match(lines, /2 decisions in 1 workspace/);
  assert.match(lines, /asked targets/);
  assert.match(lines, /repeated asks with no standing answer/);
  assert.match(lines, /\(2 answered once\)/);
});

test("the command parses telemetry with a bounded limit", () => {
  assert.deepEqual(parseScopeCommand("telemetry"), { kind: "telemetry", limit: 1000 });
  assert.deepEqual(parseScopeCommand("telemetry 50"), { kind: "telemetry", limit: 50 });
  assert.deepEqual(parseScopeCommand("telemetry 999999"), { kind: "telemetry", limit: 10000 });
});
