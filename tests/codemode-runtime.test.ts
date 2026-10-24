import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createCodemodeExtension } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/index.js";
import todo from "../extensions/todo.ts";
import askUser from "../extensions/ask-user.ts";
import checkpoints from "../extensions/subagent-checkpoints.ts";

test("codemode-only reaches the todo tools through a script and nested work is unguarded by design", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-codemode-"));
  let session: any;
  let workCalls = 0;
  let calls = 0;
  const errors: unknown[] = [];
  // v2: no assessment gate, so the script calls work immediately, then declares,
  // claims and settles a plan entirely through the nested tool surface.
  const script = `
    await tools.audit_work({});
    const plan = await tools.todo_plan({goal: "Audit", tasks: [{title: "Inspect"}, {title: "Verify", deps: ["Inspect"]}]});
    const first = plan.tasks[0].id;
    await tools.todo_act({id: first, transition: "claim"});
    await tools.audit_work({});
    await tools.todo_act({id: first, transition: "done", evidence: [{kind: "file", path: "package.json"}]});
    const next = await tools.todo_next({});
    if (!next.ready) throw new Error("frontier missing");
    return "nested tools verified";
  `;
  const model: any = {
    id: "audit", name: "Audit", provider: "audit", api: "audit-scripted", baseUrl: "http://127.0.0.1:1",
    reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 2000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  try {
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [todo, askUser, checkpoints, createCodemodeExtension({ mode: "only", models: false }), pi => {
        pi.registerTool({ name: "audit_work", label: "Audit work", description: "Local test counter", parameters: Type.Object({}),
          async execute() { workCalls++; return { content: [{ type: "text", text: "ok" }], details: {} }; },
        });
        pi.on("session_start", () => pi.setActiveTools([...pi.getActiveTools(), "codemode"]));
        pi.registerProvider("audit", { api: model.api, baseUrl: model.baseUrl, apiKey: "local-test", models: [model],
          streamSimple: (_model: any, context: any) => {
            calls++;
            const tools = context.tools ?? context.messages.find((m: any) => m.role === "system")?.toolsAdded ?? [];
            assert.ok(tools.some((t: any) => t.name === "codemode"));
            assert.ok(!tools.some((t: any) => t.name === "todo_plan"), "todo tools are reached through the script, not the loadout");
            const stream = createAssistantMessageEventStream();
            const message: any = {
              role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
              content: calls === 1 ? [{ type: "toolCall", id: "script", name: "codemode", arguments: { code: script } }] : [{ type: "text", text: "Done" }],
              stopReason: calls === 1 ? "toolUse" : "stop",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            };
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: message.stopReason, message });
            return stream;
          },
        });
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(dir), model }));
    await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
    await session.prompt("Perform the local scripted audit");
    const results = session.sessionManager.getBranch().filter((e: any) => e.type === "message" && e.message.role === "toolResult");
    assert.equal(results.length, 1);
    assert.equal(results[0].message.isError, false, JSON.stringify(results[0].message.content));
    assert.match(JSON.stringify(results[0].message.content), /nested tools verified/);
    assert.equal(workCalls, 2);
    assert.equal(calls, 2);
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
