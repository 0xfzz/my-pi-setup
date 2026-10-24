import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import artifactsExtension, {
  readSidecarArtifact, writeSidecarArtifact, searchArtifacts
} from "../extensions/artifacts.ts";
import {
  ARTIFACT_TYPE, ARTIFACT_CONTEXT_TYPE, artifactCatalogContext, recordsFromBranch,
  sanitizeArtifactId, type Artifact,
} from "../lib/artifact-state.ts";

function harness(opts: { isChild?: boolean; childSession?: string; childRun?: string; childName?: string; mode?: string } = {}) {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const entries: any[] = [];
  const notifications: any[] = [];
  const widgets = new Map<string, any>();
  const autocompleteFactories: any[] = [];

  const pi: any = {
    on(name: string, fn: Function) {
      handlers.set(name, [...handlers.get(name) ?? [], fn]);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    appendEntry(customType: string, data: any) {
      entries.push({ type: "custom", customType, data, timestamp: new Date().toISOString() });
    },
  };

  const context: any = {
    mode: opts.mode ?? "tui",
    hasUI: true,
    sessionManager: { getBranch: () => entries },
    ui: {
      addAutocompleteProvider(factory: any) { autocompleteFactories.push(factory); },
      setWidget(name: string, data: any) { widgets.set(name, data); },
      notify(...args: any[]) { notifications.push(args); },
    },
  };

  const origEnv = { ...process.env };
  const origArgv = process.argv;
  if (opts.isChild) {
    const session = opts.childSession || "/tmp/child.jsonl";
    process.env.PI_SUBAGENT_SESSION = session;
    process.env.PI_SUBAGENT_ID = opts.childRun || "child-run-1";
    process.env.PI_SUBAGENT_NAME = opts.childName || "Worker";
    // A real Herdr child is always launched as `pi --session <its own file>`.
    // That argument is what ties the inherited env to this process, so a harness
    // that sets only the env is simulating a child that cannot exist.
    process.argv = [...process.argv, "--session", session];
  } else {
    delete process.env.PI_SUBAGENT_SESSION;
    delete process.env.PI_SUBAGENT_ID;
    delete process.env.PI_SUBAGENT_NAME;
  }

  artifactsExtension(pi);

  // Restore env
  process.env = origEnv;
  process.argv = origArgv;

  async function emit(name: string, event: any = {}) {
    let result: any;
    for (const fn of handlers.get(name) ?? []) {
      result = (await fn(event, context)) ?? result;
    }
    return result;
  }

  return { pi, context, emit, tools, commands, entries, widgets, notifications, autocompleteFactories };
}

test("main session saves, updates, and tracks artifacts on the active branch", async () => {
  const h = harness();
  await h.emit("session_start");

  // Save new spec artifact
  const res1 = await h.tools.get("artifact_save").execute("c1", {
    id: "auth-spec",
    title: "Authentication Architecture Spec",
    type: "spec",
    content: "# Auth Spec\nOAuth2 with PKCE flow.",
    tags: ["auth", "security"],
  }, undefined, undefined, h.context);

  assert.equal(res1.details.id, "auth-spec");
  assert.equal(res1.details.version, 1);
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].type, "custom");
  assert.equal(h.entries[0].customType, ARTIFACT_TYPE);

  // Update existing artifact
  const res2 = await h.tools.get("artifact_save").execute("c2", {
    id: "auth-spec",
    title: "Authentication Architecture Spec v2",
    type: "spec",
    content: "# Auth Spec v2\nUpdated with Redis session storage.",
    tags: ["auth", "redis"],
  }, undefined, undefined, h.context);

  assert.equal(res2.details.version, 2);
  assert.equal(h.entries.length, 2);

  // Rebuild branch map
  const activeMap = recordsFromBranch(h.entries);
  assert.equal(activeMap.size, 1);
  assert.equal(activeMap.get("auth-spec")?.version, 2);
  assert.equal(activeMap.get("auth-spec")?.title, "Authentication Architecture Spec v2");
  assert.match(activeMap.get("auth-spec")?.content || "", /Redis session/);
});

test("context hook injects compact artifact catalog without duplicating entries", async () => {
  const h = harness();
  await h.emit("session_start");

  await h.tools.get("artifact_save").execute("c1", {
    id: "migration-plan",
    title: "Database Migration Steps",
    type: "plan",
    content: "1. Migrate users\n2. Migrate orders",
  }, undefined, undefined, h.context);

  const initialMessages: any[] = [
    { role: "user", content: "Let's begin the migration" }
  ];

  const ctxRes = await h.emit("context", { messages: initialMessages });
  assert.ok(ctxRes?.messages);
  const catalogMsg = ctxRes.messages.find((m: any) => m.role === "custom" && m.customType === ARTIFACT_CONTEXT_TYPE);
  assert.ok(catalogMsg, "Catalog message was injected");
  assert.match(catalogMsg.content, /migration-plan/);
  assert.match(catalogMsg.content, /Database Migration Steps/);

  // Re-running context does not accumulate duplicates
  const secondCtx = await h.emit("context", { messages: ctxRes.messages });
  const catalogCount = secondCtx.messages.filter((m: any) => m.role === "custom" && m.customType === ARTIFACT_CONTEXT_TYPE).length;
  assert.equal(catalogCount, 1, "Only one catalog entry injected");
});

test("artifact_recall retrieves full content by ID and searches across tags and text", async () => {
  const h = harness();
  await h.emit("session_start");

  await h.tools.get("artifact_save").execute("c1", {
    id: "api-schema",
    title: "REST API Schema",
    type: "spec",
    content: "POST /api/v1/checkout { cartId, paymentToken }",
    tags: ["api", "checkout"],
  }, undefined, undefined, h.context);

  // Recall exact ID
  const full = await h.tools.get("artifact_recall").execute("c2", { id: "api-schema" }, undefined, undefined, h.context);
  assert.match(full.content[0].text, /POST \/api\/v1\/checkout/);
  assert.match(full.content[0].text, /=== Artifact: \[api-schema\]/);

  // Search by keyword
  const searchHit = await h.tools.get("artifact_recall").execute("c3", { query: "checkout" }, undefined, undefined, h.context);
  assert.equal(searchHit.details.count, 1);
  assert.match(searchHit.content[0].text, /Found 1 matching artifact/);

  // Search miss
  const searchMiss = await h.tools.get("artifact_recall").execute("c4", { query: "nonexistent" }, undefined, undefined, h.context);
  assert.equal(searchMiss.details.count, 0);

  // Non-existent exact ID throws
  await assert.rejects(async () => {
    await h.tools.get("artifact_recall").execute("c5", { id: "missing-id" }, undefined, undefined, h.context);
  }, /Artifact \[missing-id\] not found/);
});

test("subagents stage artifacts to atomic sidecars which parent ingests into main conversation", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "pi-artifact-test-"));
  try {
    const childSession = join(tmp, "child_session.jsonl");
    const childRun = "run-abc-123";

    // 1. Child environment saves artifact
    const childHarness = harness({
      isChild: true,
      childSession,
      childRun,
      childName: "ScoutWorker",
    });

    const childRes = await childHarness.tools.get("artifact_save").execute("child-1", {
      id: "worker-findings",
      title: "Scout Worker Audit Findings",
      type: "scratchpad",
      content: "Found 3 memory leaks in database connection pool.",
      tags: ["leak", "database"],
    }, undefined, undefined, childHarness.context);

    assert.ok(childRes.details.staged);
    assert.match(childRes.content[0].text, /delivered to the main conversation/);

    // Verify sidecar file exists on disk
    const sidecarFile = `${childSession}.artifact.worker-findings.json`;
    const sidecarArt = await readSidecarArtifact(sidecarFile);
    assert.ok(sidecarArt);
    assert.equal(sidecarArt.id, "worker-findings");
    assert.equal(sidecarArt.createdBy, "subagent:ScoutWorker:run-abc-123");

    // 2. Parent environment ingests child directory
    const parentHarness = harness();
    await parentHarness.emit("session_start");

    // Parent simulates tool execution of subagent or completion
    await parentHarness.emit("tool_execution_end", {
      toolName: "subagent",
      isError: false,
      result: { details: { sessionFile: childSession } }
    });

    // Verify parent now has the artifact on its branch
    assert.equal(parentHarness.entries.length, 1);
    assert.equal(parentHarness.entries[0].customType, ARTIFACT_TYPE);
    assert.equal(parentHarness.entries[0].data.id, "worker-findings");
    assert.equal(parentHarness.entries[0].data.createdBy, "subagent:ScoutWorker:run-abc-123");

    // Replay parent branch
    const parentMap = recordsFromBranch(parentHarness.entries);
    assert.equal(parentMap.get("worker-findings")?.title, "Scout Worker Audit Findings");

    // Child mentions can resolve staged files and the inherited parent snapshot.
    await parentHarness.tools.get("artifact_save").execute("p1", {
      id: "parent-plan", title: "Parent plan", type: "plan", content: "Inherited parent context.",
    }, undefined, undefined, parentHarness.context);
    await parentHarness.emit("tool_execution_end", {
      toolName: "subagent_resume", isError: false, result: { details: { sessionFile: childSession } },
    });
    const mentioned = await childHarness.emit("input", {
      text: "Use @artifact:worker-findings and @artifact:parent-plan", source: "interactive",
    });
    assert.doesNotMatch(mentioned.text, /Found 3 memory leaks/);
    assert.doesNotMatch(mentioned.text, /Inherited parent context/);
    assert.match(mentioned.text, /@artifact:worker-findings/);
    assert.match(mentioned.text, /@artifact:parent-plan/);
    assert.match(mentioned.text, /artifact_recall/);

    await parentHarness.emit("session_shutdown");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("@ mentions install once at startup, follow the current branch and preserve input images", async () => {
  const h = harness();
  await h.emit("session_start");
  assert.equal(h.autocompleteFactories.length, 1);
  const native = {
    getSuggestions: async () => null,
    applyCompletion: () => { throw new Error("Artifact completion must not delegate to files"); },
  };
  const provider = h.autocompleteFactories[0](native);
  const suggestions = () => provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal });
  assert.equal(await suggestions(), null);
  await h.tools.get("artifact_save").execute("c1", {
    id: "current-spec", title: "Current spec", type: "spec", content: "First version.",
  }, undefined, undefined, h.context);
  assert.equal((await suggestions()).items[0].value, "@artifact:current-spec");
  const images = [{ type: "image", data: "test", mimeType: "image/png" }];
  const result = await h.emit("input", { text: "Use @artifact:current-spec", images, source: "interactive" });
  assert.equal(result.action, "transform");
  assert.doesNotMatch(result.text, /First version/);
  assert.match(result.text, /v1, spec/);
  assert.match(result.text, /artifact_recall/);
  assert.equal(result.images, images);
  await h.tools.get("artifact_save").execute("c2", {
    id: "current-spec", title: "Updated spec", type: "spec", content: "Second version.",
  }, undefined, undefined, h.context);
  const updated = await h.emit("input", { text: "Use @artifact:current-spec", source: "rpc" });
  assert.match(updated.text, /v2, spec/);
  assert.doesNotMatch(updated.text, /Second version/);
  assert.match(result.text, /v1, spec/, "previous submission remains a versioned snapshot");

  h.entries.length = 0;
  await h.emit("session_tree");
  assert.equal(h.autocompleteFactories.length, 1, "tree navigation must not stack duplicate providers");
  assert.equal(await suggestions(), null);
  const missing = await h.emit("input", { text: "Use @artifact:current-spec", source: "interactive" });
  assert.match(missing.text, /not available on the active branch/);
  assert.doesNotMatch(missing.text, /Second version/);
  assert.deepEqual(await h.emit("input", { text: "Read @src/file.ts" }), { action: "continue" });
  await h.emit("session_shutdown");
  assert.equal(await suggestions(), null);
});

test("non-TUI sessions resolve mentions without installing terminal UI", async () => {
  for (const mode of ["rpc", "print", "json"]) {
    const h = harness({ mode });
    await h.emit("session_start");
    assert.equal(h.autocompleteFactories.length, 0);
    await h.tools.get("artifact_save").execute("c1", {
      id: "spec", title: "Spec", type: "spec", content: "Headless artifact contents.",
    }, undefined, undefined, h.context);
    const headless = (await h.emit("input", { text: "@artifact:spec" })).text;
    assert.doesNotMatch(headless, /Headless artifact contents/);
    assert.match(headless, /artifact_recall/);
    assert.match(headless, /v1, spec/);
    await h.emit("session_shutdown");
  }
});
