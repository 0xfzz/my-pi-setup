import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import checkpoints from "../extensions/subagent-checkpoints.ts";
import { recordsFromBranch } from "../lib/subagent-state.ts";
import { patchedHerdrRoot } from "./fixtures/herdr-root.ts";

test("real Pi preserves delegated work across native compaction and a saved-session reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-checkpoint-runtime-"));
  const file = join(dir, "child.jsonl");
  let session: any;
  const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 5000 }, retry: { enabled: false }, cacheWarming: "off" });
  let calls = 0;
  const errors: unknown[] = [];
  const captured: string[] = [];
  const model: any = { id: "checkpoint-local-test", name: "Checkpoint local test", provider: "checkpoint-test", api: "checkpoint-scripted", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
  const scripted = (_model: any, context: any) => {
    calls++;
    captured.push(JSON.stringify(context.messages));
    const stream = createAssistantMessageEventStream();
    const tool = calls === 1;
    const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: tool ? [{ type: "toolCall", id: "child-launch", name: "subagent", arguments: { task: "Inspect login regression" } }] : [{ type: "text", text: "Acknowledged." }], stopReason: tool ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message });
    return stream;
  };
  async function start(manager: any) {
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [checkpoints, pi => {
        pi.registerProvider("checkpoint-test", { api: model.api, baseUrl: model.baseUrl, apiKey: "local-test-not-a-secret", models: [model], streamSimple: scripted });
        pi.registerTool({ name: "subagent", label: "Fixture child", description: "Fixture", parameters: Type.Object({ task: Type.String() }), async execute(_id, input) {
          return { content: [{ type: "text", text: "Child started" }], details: { id: "fixture-run", status: "started", name: "Fixture child", task: input.task, sessionFile: file } };
        } });
        // Native compaction API with an offline summary fixture: no inference.
        pi.on("session_before_compact", event => ({ compaction: { summary: "Fixture compacted summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }));
      }],
    });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const created = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: manager, model });
    session = created.session;
    await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
  }
  try {
    await start(SessionManager.create(dir, dir));
    await session.prompt("Delegate the login review.");
    assert.ok(captured.at(-1)!.includes("Delegated work checkpoints"), "context injection reaches actual provider");
    const records = recordsFromBranch(session.sessionManager.getBranch());
    assert.equal(records.get(file)?.task, "Inspect login regression");
    await session.sendCustomMessage({ customType: "subagent_result", content: "Child fixed the validation regression", display: true, details: { sessionFile: file, name: "Fixture child", disposition: "completed", summary: "Validation fix is in src/login.ts; 3 regression tests pass." } });
    await session.prompt("What did the child find?");
    assert.ok(captured.at(-1)!.includes("3 regression tests pass"));
    const compacted = await session.compact();
    assert.equal(compacted.summary, "Fixture compacted summary");
    await session.prompt("Remember delegated work after compaction.");
    assert.ok(captured.at(-1)!.includes("Delegated work checkpoints"));
    assert.ok(captured.at(-1)!.includes("Validation fix is in src/login.ts"));
    assert.equal(recordsFromBranch(session.sessionManager.getBranch()).get(file)?.status, "completed");
    const saved = session.sessionManager.getSessionFile();
    session.dispose(); session = undefined;
    await start(SessionManager.open(saved));
    await session.prompt("Recall the saved delegation after reload.");
    assert.ok(captured.at(-1)!.includes("3 regression tests pass"));
    assert.deepEqual(errors, []);
  } finally { session?.dispose(); await rm(dir, { recursive: true, force: true }); }
});

/**
 * Phase 6 runtime fork case.
 *
 * The seed is produced by the REAL Herdr patch and the child is a REAL Pi
 * session opened on that file, so this covers the seam the unit tests cannot:
 * inherited parent text reaching the model, the provenance mention reaching the
 * model, and `orch_parent_recall` doing a live round trip back to the parent file.
 *
 * The task ticket itself is delivered through argv by Herdr's launch script
 * (covered by `launch.test.ts`), so it is deliberately absent here: a fork
 * child's *session* file starts with the parent's copied branch, not a ticket.
 */
test("a fork child inherits parent text, knows its provenance, and can pull from the parent", async () => {
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const herdrRoot = patchedHerdrRoot();

  const dir = mkdtempSync(join(tmpdir(), "pi-fork-runtime-"));
  const parentFile = join(dir, "parent.jsonl");
  const childFile = join(dir, "child.jsonl");
  const envKeys = ["PI_SUBAGENT_SESSION", "PI_SUBAGENT_ID", "PI_SUBAGENT_PARENT"] as const;
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const savedArgv = process.argv;
  let session: any;

  try {
    if (!herdrRoot) return; // patched producer unavailable: nothing to verify

    writeFileSync(parentFile, [
      { type: "session", id: "sess-parent", version: 3, cwd: dir },
      { type: "message", id: "u1", parentId: null,
        message: { role: "user", content: [{ type: "text", text: "Pick a hashing library." }] } },
      { type: "message", id: "a1", parentId: "u1",
        message: { role: "assistant", content: [{ type: "text", text: "PARENT DECISION: use bcrypt for password hashing." }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

    const { seedSubagentSessionFile } = await import(join(herdrRoot, "src", "session.ts"));
    seedSubagentSessionFile({
      mode: "fork", parentSessionFile: parentFile, childSessionFile: childFile, childCwd: dir,
    });

    // Herdr child env must be visible BEFORE the extension factory runs: the
    // extension binds its child identity at load time. The identity is proven
    // against `--session <this child's file>`, which Herdr always passes (launch
    // and resume alike), so the harness must pass it too.
    process.env.PI_SUBAGENT_SESSION = childFile;
    process.env.PI_SUBAGENT_ID = "runtime-child-run";
    process.env.PI_SUBAGENT_PARENT = parentFile;
    process.argv = [...process.argv, "--session", childFile];

    const settings = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
    });
    const model: any = {
      id: "fork-runtime", name: "Fork runtime", provider: "fork-runtime-test", api: "fork-runtime-scripted",
      baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000, maxTokens: 1000,
    };
    const captured: string[] = [];
    const errors: unknown[] = [];
    let calls = 0;
    const scripted = () => {
      calls++;
      const wantsRecall = calls === 1;
      const message: any = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: wantsRecall
          ? [{ type: "toolCall", id: "pull-parent", name: "orch_parent_recall", arguments: { query: "bcrypt" } }]
          : [{ type: "text", text: "Recalled the parent's decision." }],
        stopReason: wantsRecall ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    };

    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [checkpoints, pi => {
        pi.registerProvider(model.provider, {
          api: model.api, baseUrl: model.baseUrl, apiKey: "local-test-not-a-secret", models: [model],
          streamSimple: (_m: any, context: any) => { captured.push(JSON.stringify(context.messages)); return scripted(); },
        });
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);

    const created = await createAgentSession({
      cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings,
      sessionManager: SessionManager.open(childFile, dir, dir), model,
    });
    session = created.session;
    await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
    await session.prompt("Continue the work.");

    const firstRequest = captured[0];
    // 1. The fork seed's inherited parent work is in the child's context.
    assert.ok(firstRequest.includes("PARENT DECISION: use bcrypt"), "fork child inherits the parent's branch content");
    // 2. The child is told how it was seeded, so it can judge its own staleness.
    assert.ok(firstRequest.includes("your context: fork"), "the child's provenance reaches the model");
    // 3. The pull path is advertised and genuinely registered.
    assert.ok(firstRequest.includes("orch_parent_recall"), "the child is told the pull tool exists");
    assert.ok(session.getActiveToolNames().includes("orch_parent_recall"));

    // 4. A live pull reaches the parent file and its result reaches the provider.
    const afterTool = captured.at(-1)!;
    assert.ok(afterTool.includes("Parent session:"), "the pull states which parent it read");
    assert.ok(afterTool.includes("Read-only: this never modifies the parent session"));
    assert.ok(afterTool.includes("bcrypt"), "the recalled parent content reaches the model");
    // The parent file is evidence: reading it must never rewrite it.
    assert.ok(readFileSync(parentFile, "utf8").includes("PARENT DECISION: use bcrypt"));
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    process.argv = savedArgv;
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
