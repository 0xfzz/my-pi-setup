import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parentSessionOf,
  provenanceFromBranch,
  provenanceFromHeader,
  provenanceLine,
  provenanceOf,
  contextModeLabel,
  estimateTokens,
  type ContextProvenance,
} from "../lib/subagent-context.ts";
import {
  boundPull,
  defaultNewerThanSeed,
  parentPullHeader,
  readChildSeed,
  resolveParentContext,
} from "../lib/parent-context.ts";

const PROVENANCE: ContextProvenance = {
  version: 1,
  mode: "fork",
  parentSession: "/sessions/parent.jsonl",
  parentLeafId: "asst-001",
  parentSessionId: "parent-id",
  seededAt: "2026-10-23T01:00:00.000Z",
  seededEntries: 4,
  seededChars: 4000,
  estimatedTokens: 1000,
  truncated: null,
};

function tmp() {
  return mkdtempSync(join(tmpdir(), "pi-parent-context-"));
}

test("provenanceOf validates untrusted records and rejects unknown modes", () => {
  const valid = provenanceOf(PROVENANCE);
  assert.equal(valid?.mode, "fork");
  assert.equal(valid?.estimatedTokens, 1000);

  // Mode is never coerced: an unrecognized shape must not silently become "fresh".
  assert.equal(provenanceOf({ ...PROVENANCE, mode: "inherited" }), undefined);
  assert.equal(provenanceOf({ ...PROVENANCE, version: 2 }), undefined);
  assert.equal(provenanceOf({ ...PROVENANCE, parentSession: "" }), undefined);
  assert.equal(provenanceOf({ ...PROVENANCE, parentSessionId: "" }), undefined);
  assert.equal(provenanceOf({ ...PROVENANCE, seededAt: "not-a-date" }), undefined);
  assert.equal(provenanceOf(null), undefined);
  assert.equal(provenanceOf("fork"), undefined);
});

test("provenanceOf keeps only well-formed truncation and drops invented fields", () => {
  const truncated = provenanceOf({
    ...PROVENANCE,
    truncated: { at: "trailing-user-message", droppedEntries: 1 },
    degradedFrom: "fork",
    briefSource: "vcc",
    secretsRedacted: 2,
  });
  assert.deepEqual(truncated?.truncated, { at: "trailing-user-message", droppedEntries: 1 });
  // The budget-degradation concept was removed: fork always copies in full.
  assert.equal("degradedFrom" in (truncated as object), false);
  assert.equal(truncated?.briefSource, "vcc");
  assert.equal(truncated?.secretsRedacted, 2);

  const bogus = provenanceOf({ ...PROVENANCE, truncated: { at: "somewhere", droppedEntries: -5 } });
  assert.equal(bogus?.truncated, null);
});

test("provenanceOf treats negative and non-finite counters as zero", () => {
  const p = provenanceOf({
    ...PROVENANCE,
    seededEntries: -3,
    seededChars: Number.NaN,
    estimatedTokens: -1,
  });
  assert.equal(p?.seededEntries, 0);
  assert.equal(p?.seededChars, 0);
  assert.equal(p?.estimatedTokens, 0);
});

test("estimateTokens is chars/4 and never negative", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(3), 1);
  assert.equal(estimateTokens(4000), 1000);
  assert.equal(estimateTokens(-50), 0);
  assert.equal(estimateTokens(Number.NaN), 0);
});

test("provenanceFromBranch takes the latest entry and ignores malformed ones", () => {
  const branch = [
    { type: "custom", customType: "subagent-context:v1", data: PROVENANCE },
    { type: "custom", customType: "subagent-context:v1", data: { ...PROVENANCE, mode: "bogus" } },
    { type: "custom", customType: "other", data: PROVENANCE },
    { type: "custom", customType: "subagent-context:v1", data: { ...PROVENANCE, mode: "digest" } },
  ];
  assert.equal(provenanceFromBranch(branch)?.mode, "digest");
  assert.equal(provenanceFromBranch([{ type: "custom", customType: "subagent-context:v1", data: { mode: "fork" } }]), undefined);
  assert.equal(provenanceFromBranch(undefined), undefined);
});

test("provenanceFromHeader reads the header copy", () => {
  assert.equal(provenanceFromHeader({ contextProvenance: PROVENANCE })?.mode, "fork");
  assert.equal(provenanceFromHeader({}), undefined);
  assert.equal(provenanceFromHeader(null), undefined);
});

test("parentSessionOf ignores a self-referential provenance record", () => {
  const self = { ...PROVENANCE, parentSessionId: "child-id" };
  assert.equal(parentSessionOf(self, { id: "child-id", parentSession: "/x.jsonl" }), undefined);
  // No provenance: the header is the only signal available.
  assert.equal(parentSessionOf(undefined, { parentSession: "/sessions/parent.jsonl" }), "/sessions/parent.jsonl");
  assert.equal(parentSessionOf(undefined, {}), undefined);
  // A recorded provenance outranks the header.
  assert.equal(parentSessionOf(provenanceOf(PROVENANCE), { parentSession: "/other.jsonl" }), "/sessions/parent.jsonl");
});

test("contextModeLabel and provenanceLine describe each shape without inventing facts", () => {
  const fork = provenanceOf(PROVENANCE)!;
  assert.match(contextModeLabel(fork), /^fork · 1k inherited$/);
  assert.match(provenanceLine(fork), /context: fork/);
  assert.match(provenanceLine(fork), /seed leaf: asst-001/);

  const truncated = provenanceOf({
    ...PROVENANCE,
    truncated: { at: "trailing-user-message", droppedEntries: 1 },
    secretsRedacted: 2,
  })!;
  assert.match(contextModeLabel(truncated), /trailing turn dropped/);
  assert.match(provenanceLine(truncated), /secret-shaped value/);

  const fresh = provenanceOf({
    ...PROVENANCE, mode: "fresh", seededEntries: 0, seededChars: 0, estimatedTokens: 0, parentLeafId: null,
  })!;
  assert.equal(contextModeLabel(fresh), "fresh");
  assert.match(provenanceLine(fresh), /seed leaf: empty parent branch/);

  const digest = provenanceOf({ ...PROVENANCE, mode: "digest", seededEntries: 0, briefSource: "vcc" })!;
  assert.equal(contextModeLabel(digest), "digest · parent brief");
});

test("readChildSeed detects the seeded prefix as everything before the provenance entry", () => {
  const dir = tmp();
  try {
    const childFile = join(dir, "child.jsonl");
    const lines = [
      { type: "session", id: "child-id", version: 3, parentSession: "/sessions/parent.jsonl" },
      { type: "model_change", id: "mc-001", parentId: null },
      { type: "message", id: "user-001", parentId: "mc-001", message: { role: "user", content: [] } },
      { type: "custom", id: "ctx-001", parentId: "user-001", customType: "subagent-context:v1", data: PROVENANCE },
      // Everything after the provenance entry is the child's own work.
      { type: "message", id: "own-001", parentId: "ctx-001", message: { role: "assistant", content: [] } },
    ];
    writeFileSync(childFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const seed = readChildSeed(childFile);
    assert.equal(seed?.header?.id, "child-id");
    assert.equal(seed?.provenance?.mode, "fork");
    assert.deepEqual([...seed!.seededEntryIds].sort(), ["mc-001", "user-001"]);
    assert.equal(seed!.seededEntryIds.has("own-001"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readChildSeed returns undefined for a missing or unparsable file", () => {
  const dir = tmp();
  try {
    assert.equal(readChildSeed(join(dir, "absent.jsonl")), undefined);
    const junk = join(dir, "junk.jsonl");
    writeFileSync(junk, "not json at all\n");
    // No session header: not a session this child can reason about.
    const seed = readChildSeed(junk);
    assert.equal(seed?.provenance, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveParentContext requires a reachable parent file", () => {
  const dir = tmp();
  try {
    const parentFile = join(dir, "parent.jsonl");
    const childFile = join(dir, "child.jsonl");
    writeFileSync(parentFile, JSON.stringify({ type: "session", id: "parent-id", version: 3, cwd: dir }) + "\n");
    writeFileSync(childFile, [
      { type: "session", id: "child-id", version: 3, parentSession: parentFile },
      { type: "custom", id: "ctx-001", parentId: null, customType: "subagent-context:v1", data: { ...PROVENANCE, parentSession: parentFile } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n");

    const resolved = resolveParentContext(childFile, undefined);
    assert.equal(resolved?.sessionFile, parentFile);
    assert.equal(resolved?.provenance?.mode, "fork");

    // A recorded parent that no longer exists yields no context rather than an error.
    const orphan = join(dir, "orphan.jsonl");
    writeFileSync(orphan, [
      { type: "session", id: "orphan-id", version: 3, parentSession: join(dir, "gone.jsonl") },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n");
    assert.equal(resolveParentContext(orphan, undefined), undefined);
    assert.equal(resolveParentContext(undefined, parentFile), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveParentContext prefers the live env parent over recorded provenance", () => {
  const dir = tmp();
  try {
    const seededParent = join(dir, "seeded.jsonl");
    const liveParent = join(dir, "live.jsonl");
    const childFile = join(dir, "child.jsonl");
    for (const file of [seededParent, liveParent]) {
      writeFileSync(file, JSON.stringify({ type: "session", id: "p", version: 3, cwd: dir }) + "\n");
    }
    writeFileSync(childFile, [
      { type: "session", id: "child-id", version: 3, parentSession: seededParent },
      { type: "custom", id: "ctx-001", parentId: null, customType: "subagent-context:v1", data: { ...PROVENANCE, parentSession: seededParent } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n");

    assert.equal(resolveParentContext(childFile, liveParent)?.sessionFile, liveParent);
    // A stale env pointer must not mask a perfectly good recorded parent.
    assert.equal(
      resolveParentContext(childFile, join(dir, "gone.jsonl"))?.sessionFile,
      seededParent,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh child with no parentSession header can still reach its parent via env", () => {
  const dir = tmp();
  try {
    const parentFile = join(dir, "parent.jsonl");
    writeFileSync(parentFile, JSON.stringify({ type: "session", id: "p", version: 3, cwd: dir }) + "\n");
    const childFile = join(dir, "fresh-child.jsonl");
    // No parentSession anywhere: env is the only pointer.
    writeFileSync(childFile, JSON.stringify({ type: "session", id: "child-id", version: 3 }) + "\n");

    assert.equal(resolveParentContext(childFile, undefined), undefined);
    const resolved = resolveParentContext(childFile, parentFile);
    assert.equal(resolved?.sessionFile, parentFile);
    assert.equal(resolved?.provenance, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultNewerThanSeed reports a delta only for forks", () => {
  const fork = { childSessionFile: "c", sessionFile: "p", provenance: provenanceOf(PROVENANCE), seededEntryIds: new Set<string>() };
  assert.equal(defaultNewerThanSeed(fork), true);
  assert.equal(defaultNewerThanSeed({ ...fork, provenance: provenanceOf({ ...PROVENANCE, mode: "digest" }) }), false);
  assert.equal(defaultNewerThanSeed({ ...fork, provenance: undefined }), false);
});

test("parentPullHeader states the delta honestly and always names read-only", () => {
  const fork = {
    childSessionFile: "c",
    sessionFile: "/sessions/parent.jsonl",
    provenance: provenanceOf(PROVENANCE),
    seededEntryIds: new Set(["a", "b"]),
  };
  const delta = parentPullHeader(fork, true);
  assert.match(delta, /Showing only entries the parent added AFTER your 2-entry snapshot/);
  assert.match(delta, /Read-only/);
  assert.match(parentPullHeader(fork, false), /Including the 2 entries your snapshot already contains/);

  const fresh = { ...fork, provenance: undefined, seededEntryIds: new Set<string>() };
  assert.match(parentPullHeader(fresh, false), /unknown \(no provenance record\)/);
});

test("boundPull caps output and says so, leaving short output untouched", () => {
  const short = boundPull("hello", 100);
  assert.deepEqual(short, { text: "hello", truncated: false });
  const long = boundPull("x".repeat(500), 100);
  assert.equal(long.truncated, true);
  assert.ok(long.text.length < 500);
  assert.match(long.text, /character cap/);
});
