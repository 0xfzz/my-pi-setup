import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import artifactsExtension, {
  publishChildSnapshot,
  readSidecarArtifact,
} from "../extensions/artifacts.ts";
import {
  sanitizeScope,
  visibleToScope,
  hasScopedSpecs,
  parentArtifactsSnapshotPath,
  artifactSidecarPath,
  type Artifact,
} from "../lib/artifact-state.ts";

test("sanitizeScope validates, normalizes, and rejects invalid scopes", () => {
  assert.equal(sanitizeScope("auth-service"), "auth-service");
  assert.equal(sanitizeScope("  Net_Layer_123  "), "net_layer_123");
  assert.equal(sanitizeScope("global"), undefined, "global is reserved");
  assert.equal(sanitizeScope("GLOBAL"), undefined, "global case-insensitive is reserved");
  assert.equal(sanitizeScope("."), undefined, ". is rejected");
  assert.equal(sanitizeScope(".."), undefined, ".. is rejected");
  assert.equal(sanitizeScope(""), undefined, "empty is rejected");
  assert.equal(sanitizeScope("   "), undefined, "whitespace is rejected");
  assert.equal(sanitizeScope(null), undefined);
  assert.equal(sanitizeScope(undefined), undefined);
});

test("visibleToScope enforces strict scope boundaries", () => {
  const globalArt: Artifact = {
    id: "vision",
    title: "Project Vision",
    type: "plan",
    content: "Global goals",
    version: 1,
    createdBy: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: [],
  };

  const scopedArtA: Artifact = {
    id: "spec-a",
    title: "Module A Spec",
    type: "spec",
    content: "Lane A criteria",
    version: 1,
    createdBy: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: [],
    scope: "module-a",
  };

  const scopedArtB: Artifact = {
    id: "spec-b",
    title: "Module B Spec",
    type: "spec",
    content: "Lane B criteria",
    version: 1,
    createdBy: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: [],
    scope: "module-b",
  };

  // Global artifact is visible to all scopes and undefined
  assert.equal(visibleToScope(globalArt, "module-a"), true);
  assert.equal(visibleToScope(globalArt, "module-b"), true);
  assert.equal(visibleToScope(globalArt, undefined), true);

  // Scoped artifact A is visible only to module-a
  assert.equal(visibleToScope(scopedArtA, "module-a"), true);
  assert.equal(visibleToScope(scopedArtA, "module-b"), false);
  assert.equal(visibleToScope(scopedArtA, undefined), false);

  // Scoped artifact B is visible only to module-b
  assert.equal(visibleToScope(scopedArtB, "module-b"), true);
  assert.equal(visibleToScope(scopedArtB, "module-a"), false);
  assert.equal(visibleToScope(scopedArtB, undefined), false);

  assert.equal(hasScopedSpecs([globalArt]), false);
  assert.equal(hasScopedSpecs([globalArt, scopedArtA]), true);
});

test("publishChildSnapshot isolates specs when scope is provided, and preserves v1 when scope is undefined (R1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snap-test-"));
  const childSessionFile = join(dir, "child-run.jsonl");

  try {
    const globalArt: Artifact = {
      id: "vision",
      title: "Global Vision",
      type: "plan",
      content: "Vision content",
      version: 1,
      createdBy: "main",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: [],
    };

    const specA: Artifact = {
      id: "a-spec",
      title: "A Spec",
      type: "spec",
      content: "A spec details",
      version: 1,
      createdBy: "main",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: [],
      scope: "scope-a",
    };

    const specB: Artifact = {
      id: "b-spec",
      title: "B Spec",
      type: "spec",
      content: "B spec details",
      version: 1,
      createdBy: "main",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: [],
      scope: "scope-b",
    };

    const catalog = new Map<string, Artifact>([
      [globalArt.id, globalArt],
      [specA.id, specA],
      [specB.id, specB],
    ]);

    // 1. Scoped child (scope-a) -> receives globals + specA, NEVER specB
    await publishChildSnapshot(dir, childSessionFile, "scope-a", catalog);
    const snapPath = parentArtifactsSnapshotPath(childSessionFile);
    const deliveredScoped: Artifact[] = JSON.parse(await readFile(snapPath, "utf8"));
    const idsScoped = deliveredScoped.map((a) => a.id);
    assert.ok(idsScoped.includes("vision"), "globals included");
    assert.ok(idsScoped.includes("a-spec"), "own spec included");
    assert.ok(!idsScoped.includes("b-spec"), "foreign spec EXCLUDED");

    // 2. Unscoped child (v1) -> receives the whole catalog (R1 non-interference)
    await publishChildSnapshot(dir, childSessionFile, undefined, catalog);
    const deliveredV1: Artifact[] = JSON.parse(await readFile(snapPath, "utf8"));
    const idsV1 = deliveredV1.map((a) => a.id);
    assert.ok(idsV1.includes("vision"));
    assert.ok(idsV1.includes("a-spec"));
    assert.ok(idsV1.includes("b-spec"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parent saving scoped spec writes sidecar-only to keep branch clean for fork safety", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spec-parent-test-"));
  const sessionFile = join(dir, "parent-session.jsonl");
  await writeFile(sessionFile, "", "utf8");

  try {
    const appendedEntries: any[] = [];
    const tools = new Map<string, any>();
    const pi: any = {
      on() {},
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      appendEntry(customType: string, data: any) {
        appendedEntries.push({ customType, data });
      },
    };

    const context: any = {
      hasUI: false,
      sessionManager: {
        getBranch: () => [],
        getSessionFile: () => sessionFile,
      },
      ui: { setWidget() {}, notify() {} },
    };

    artifactsExtension(pi);
    const saveTool = tools.get("artifact_save");
    assert.ok(saveTool);

    // Save a scoped spec
    const res = await saveTool.execute(
      "call-1",
      {
        id: "worker-1.spec",
        title: "Worker 1 Specification",
        type: "spec",
        content: "# Criteria for worker 1\nfiles in lane: src/worker1/*",
        scope: "worker-1",
      },
      undefined,
      undefined,
      context,
    );

    assert.equal(res.details.sidecarOnly, true);
    assert.equal(res.details.scope, "worker-1");

    // Crucial: no entry appended to parent branch (prevents fork leakage!)
    assert.equal(
      appendedEntries.filter((e) => e.data?.id === "worker-1.spec").length,
      0,
      "scoped spec must not be appended to branch entries",
    );

    // But sidecar file exists on disk
    const sidecar = artifactSidecarPath(sessionFile, "worker-1.spec");
    const sidecarContent = await readSidecarArtifact(sidecar);
    assert.ok(sidecarContent);
    assert.equal(sidecarContent.id, "worker-1.spec");
    assert.equal(sidecarContent.scope, "worker-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
