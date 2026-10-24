import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import modes from "../extensions/modes.ts";
import todo from "../extensions/todo.ts";
import checkpoints from "../extensions/subagent-checkpoints.ts";
import { PLAN_MODE_TYPE, planModeFromBranch } from "../lib/plan-mode.ts";
import { SUBAGENT_CONTEXT_TYPE, childContextState, ownEntries } from "../lib/subagent-context.ts";
import { CHECKPOINT_TYPE } from "../lib/subagent-state.ts";

/**
 * A seeded child is a real Herdr child: `PI_SUBAGENT_SESSION` points at its own
 * session file, that file begins with the parent's copied entries, and the seed's
 * `subagent-context:v1` marker closes the inherited prefix. These tests drive real
 * Pi and real session files, so they cover the extension hooks rather than a
 * mocked contract.
 */

const provenance = (mode: "fresh" | "digest" | "fork") => ({
  version: 1,
  mode,
  parentSession: "/sessions/parent.jsonl",
  parentLeafId: "asst-parent",
  parentSessionId: "parent-id",
  seededAt: "2026-10-23T01:00:00.000Z",
  seededEntries: 3,
  seededChars: 300,
  estimatedTokens: 75,
  truncated: null,
});

/**
 * Branch entries a fork seed copies in, plus the seed marker.
 *
 * `childPlan` appends a decision the CHILD made about its own mode. When omitted,
 * the child has made no mode decision at all — the discriminating case, because a
 * fork seed still carries the parent's Plan entry.
 */
function forkSeedBranch(childPlan?: { enabled: boolean; previousTools: string[] }): any[] {
  const branch: any[] = [
    { type: "message", id: "user-parent", parentId: null, timestamp: "2026-10-23T00:59:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Parent asked for work" }] } },
    { type: "message", id: "asst-parent", parentId: "user-parent", timestamp: "2026-10-23T00:59:30.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Parent did the work" }] } },
    // Inherited parent policy: Plan ON, with the PARENT's wide tool snapshot.
    { type: "custom", id: "plan-parent", parentId: "asst-parent", customType: PLAN_MODE_TYPE, timestamp: "2026-10-23T00:59:40.000Z",
      data: { enabled: true, previousTools: ["read", "bash", "grep", "find", "ls", "ask_user", "write", "edit"] } },
    // Inherited parent registry: a sibling this child must never adopt.
    { type: "custom", id: "sibling", parentId: "plan-parent", customType: CHECKPOINT_TYPE, timestamp: "2026-10-23T00:59:50.000Z",
      data: { sessionFile: "/sessions/sibling.jsonl", runId: "sib-1", name: "Sibling worker", task: "Parent's other task",
        status: "running", ended: false, updatedAt: "2026-10-23T00:59:50.000Z", summary: "SIBLING FINDING", files: [], verification: "", next: "" } },
    { type: "custom", id: "seed-marker", parentId: "sibling", customType: SUBAGENT_CONTEXT_TYPE, timestamp: "2026-10-23T01:00:00.000Z",
      data: provenance("fork") },
  ];
  if (childPlan) {
    branch.push({ type: "custom", id: "plan-child", parentId: "seed-marker", customType: PLAN_MODE_TYPE,
      timestamp: "2026-10-23T01:01:00.000Z", data: childPlan });
  }
  return branch;
}

/** Run with Herdr child env pointed at a real session file, then restore it. */
async function asChild<T>(sessionFile: string, run: () => Promise<T>): Promise<T> {
  const previous = {
    session: process.env.PI_SUBAGENT_SESSION,
    id: process.env.PI_SUBAGENT_ID,
    parent: process.env.PI_SUBAGENT_PARENT,
  };
  process.env.PI_SUBAGENT_SESSION = sessionFile;
  process.env.PI_SUBAGENT_ID = "child-run";
  delete process.env.PI_SUBAGENT_PARENT;
  try {
    return await run();
  } finally {
    if (previous.session === undefined) delete process.env.PI_SUBAGENT_SESSION;
    else process.env.PI_SUBAGENT_SESSION = previous.session;
    if (previous.id === undefined) delete process.env.PI_SUBAGENT_ID;
    else process.env.PI_SUBAGENT_ID = previous.id;
    if (previous.parent === undefined) delete process.env.PI_SUBAGENT_PARENT;
    else process.env.PI_SUBAGENT_PARENT = previous.parent;
  }
}

async function fixture(extensionFactories: any[], branch: any[]) {
  const dir = await mkdtemp(join(tmpdir(), "pi-context-isolation-"));
  const sessionFile = join(dir, "child.jsonl");
  // A version-3 header line is mandatory: Pi rejects a file without one.
  const header = {
    type: "session", version: 3, id: "child-id", timestamp: "2026-10-23T01:00:00.000Z",
    cwd: dir, parentSession: "/sessions/parent.jsonl",
  };
  await writeFile(sessionFile, [header, ...branch].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
  });
  const errors: unknown[] = [];
  const model: any = {
    id: "isolation-local", name: "Isolation local", provider: "isolation-test", api: "isolation-scripted",
    baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const captured: string[] = [];
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [...extensionFactories, pi => {
      pi.registerProvider(model.provider, {
        api: model.api, baseUrl: model.baseUrl, apiKey: "local-test", models: [model],
        streamSimple: (_model: any, context: any) => {
          captured.push(JSON.stringify(context.messages));
          const message: any = {
            role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
            content: [{ type: "text", text: "Isolation fixture reply." }], stopReason: "stop",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
          return stream;
        },
      });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const created = await createAgentSession({
    cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings,
    sessionManager: SessionManager.open(sessionFile, dir, dir), model,
  });
  await created.session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
  return {
    session: created.session, errors, captured, dir, sessionFile,
    async prompt(text: string) { await created.session.prompt(text); },
    async cleanup() { await rm(dir, { recursive: true, force: true }); },
  };
}

test("ownEntries removes the inherited prefix and the seed marker itself", () => {
  const own = ownEntries(forkSeedBranch()).map((entry) => entry.id);
  assert.deepEqual(own, [], "everything before and including the marker is the seed");

  // A branch with no marker has no trustworthy boundary: nothing is stripped.
  const unmarked = forkSeedBranch().filter((entry) => entry.customType !== SUBAGENT_CONTEXT_TYPE);
  assert.equal(ownEntries(unmarked).length, unmarked.length);
  assert.equal(ownEntries([]).length, 0);
  assert.equal(ownEntries(undefined).length, 0);

  // A child's own later entry survives alongside the stripped seed.
  assert.deepEqual(
    ownEntries(forkSeedBranch({ enabled: false, previousTools: ["read", "bash"] })).map((entry) => entry.id),
    ["plan-child"],
  );
});

test("childContextState distinguishes fork, digest, fresh, and legacy children", () => {
  const fork = childContextState(forkSeedBranch(), { parentSession: "/p" }, true);
  assert.equal(fork.seeded, true);
  assert.equal(fork.provenance?.mode, "fork");
  assert.equal(fork.inheritedEntries, 4, "two messages, the parent's plan, and the sibling record");

  // A digest child seeds no entries: it is a child, but not a seeded one.
  const digestBranch = [
    { type: "custom", id: "seed-marker", parentId: null, customType: SUBAGENT_CONTEXT_TYPE, data: provenance("digest") },
  ];
  const digest = childContextState(digestBranch, { parentSession: "/p" }, true);
  assert.equal(digest.isChild, true);
  assert.equal(digest.seeded, false, "a digest child inherited no entries");
  assert.equal(digest.inheritedEntries, 0);

  const fresh = childContextState([{ type: "message", id: "u", parentId: null, message: { role: "user", content: [] } }], {}, true);
  assert.equal(fresh.seeded, false);

  // Legacy fork seeds carry a parent header but no provenance marker.
  const legacy = childContextState(
    [{ type: "message", id: "u", parentId: null, message: { role: "user", content: [] } }],
    { parentSession: "/sessions/parent.jsonl" }, true,
  );
  assert.equal(legacy.seeded, true, "legacy fork seed still isolates");
  assert.equal(legacy.provenance, undefined);

  // A branch carrying a seed marker WAS seeded, independent of the environment.
  // Hand-resuming a child (`pi --session <child>`) has no PI_SUBAGENT_SESSION, yet
  // the parent's inherited Plan entry is still not this session's decision.
  const resumedByHand = childContextState(forkSeedBranch(), { parentSession: "/p" }, false);
  assert.equal(resumedByHand.isChild, false);
  assert.equal(resumedByHand.seeded, true, "isolation follows the branch, not the environment");

  // With neither a marker nor a parent linkage there is nothing to isolate.
  assert.equal(childContextState([{ type: "message", id: "u", parentId: null, message: { role: "user", content: [] } }], {}, false).seeded, false);
});

test("a fork child does not adopt the parent's inherited Plan mode", async () => {
  const f = await fixture([modes], forkSeedBranch());
  try {
    await asChild(f.sessionFile, () => f.prompt("Do the child's own work."));
    // Control: the raw branch really does carry an enabled Plan entry, so an
    // unfiltered read would put this child into Plan mode.
    assert.equal(
      planModeFromBranch(f.session.sessionManager.getBranch())?.enabled, true,
      "control: the inherited parent entry says Plan is enabled",
    );
    // The child never chose Plan, so it stays Normal with its own full loadout.
    // Without isolation it would be read-only here.
    const active = f.session.getActiveToolNames();
    assert.equal(active.includes("write"), true, "a child that never chose Plan must keep write");
    assert.equal(active.includes("edit"), true, "a child that never chose Plan must keep edit");
    assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});

test("a fork child's own mode decision is the one applied", async () => {
  const f = await fixture([modes], forkSeedBranch({ enabled: false, previousTools: ["read", "bash"] }));
  try {
    await asChild(f.sessionFile, () => f.prompt("Do the child's own work."));
    // The child's own entry restores the loadout it recorded, and the parent's
    // wider snapshot (which names write/edit/grep/find/ls) must not be applied.
    assert.deepEqual(f.session.getActiveToolNames().sort(), ["bash", "read"]);
    assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});

test("a fork child does not replay the parent's delegated-work registry", async () => {
  const f = await fixture([checkpoints], forkSeedBranch());
  try {
    await asChild(f.sessionFile, async () => {
      await f.prompt("Do the child's own work.");
      const request = f.captured.at(-1)!;
      assert.equal(
        request.includes("Sibling worker"),
        false,
        "the parent's other delegates must not appear as this child's work",
      );
      assert.equal(request.includes("SIBLING FINDING"), false);
    });
    assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});

test("a fork child starts from its own empty plan, not the parent's plan", async () => {
  const branch: any[] = [
    ...forkSeedBranch(),
    { type: "custom", id: "parent-todo", parentId: "seed-marker", customType: "workflow-todo:v1",
      timestamp: "2026-10-23T00:59:55.000Z",
      data: { version: 1, assessed: true, reason: "Parent plan", nextId: 3,
        items: [{ id: 1, text: "PARENT TASK", status: "in_progress" }, { id: 2, text: "parent verification", status: "pending" }],
        ownerSessionId: "parent-id" } },
  ];
  const header = { type: "session", version: 3, id: "child-id", timestamp: "2026-10-23T01:00:00.000Z", cwd: "/w",
    parentSession: "/sessions/parent.jsonl" };
  await asChild("/sessions/child.jsonl", async () => {
    const hooks: Record<string, Function> = {};
    const tools: Record<string, any> = {};
    const ctx: any = {
      hasUI: false, signal: new AbortController().signal,
      sessionManager: { getBranch: () => branch, getHeader: () => header },
      ui: { setWidget() {}, notify() {} },
    };
    todo({
      on: (name: string, handler: Function) => { hooks[name] = handler; },
      registerTool: (tool: any) => { tools[tool.name] = tool; },
      registerCommand() {},
      appendEntry: (customType: string, data: any) => {
        branch.push({ type: "custom", id: `own-${branch.length}`, customType,
          timestamp: "2026-10-23T01:02:00.000Z", data: structuredClone(data) });
      },
    } as any);
    hooks.session_start({}, ctx);
    const listed = await tools.workflow_todo.execute("id", { action: "list" }, ctx.signal, undefined, ctx);
    assert.equal(
      JSON.stringify(listed).includes("PARENT TASK"),
      false,
      "the parent's plan must not leak into the fork child",
    );
  });
});
