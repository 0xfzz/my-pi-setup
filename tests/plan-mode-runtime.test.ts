import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createCodemodeExtension } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/index.js";
import modes from "../extensions/modes.ts";
import artifacts from "../extensions/artifacts.ts";
import todo from "../extensions/todo.ts";
import { ARTIFACT_TYPE, recordsFromBranch } from "../lib/artifact-state.ts";
import { isPlanTool as planToolPolicy, planModeFromBranch } from "../lib/plan-mode.ts";

const isPlanTool = (name: string) => planToolPolicy(name) || name === "readonly_io";
for (const reactivate of [false, true]) {
  test(`real Pi guards Plan tools and nested calls${reactivate ? " despite a later extension reactivating forbidden declarations" : " with codemode-only configured"}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-plan-runtime-"));
    let session: any;
    const errors: unknown[] = [];
    let requests = 0;
    let forbiddenCalls = 0;
    let nestedChecks = false;
    const model: any = { id: "plan-local", name: "Plan local", provider: "plan-test", api: "plan-scripted",
      baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 2000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    try {
      await writeFile(join(dir, "secret.txt"), "DO_NOT_ACCESS");
      const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [todo, artifacts, modes, createCodemodeExtension({ mode: "only", models: false }), pi => {
          pi.registerTool({ name: "forbidden_io", label: "Forbidden IO", description: "Deferred local counter", exposure: "deferred", parameters: Type.Object({}),
            async execute() { forbiddenCalls++; return { content: [{ type: "text", text: "escaped" }], details: undefined }; } });
          pi.registerTool({ name: "readonly_io", label: "Readonly IO", description: "Deferred reader", exposure: "deferred", annotations: { readOnlyHint: true }, parameters: Type.Object({}),
            async execute() { return { content: [{ type: "text", text: "Read-only research worked" }], details: undefined }; } });
          // A test-only control tool deliberately attempts nested calls. Registered deferred
          // tools are callable even when inactive, so this exercises tool_call, not just hiding.
          pi.registerTool({ name: "ask_user", label: "Nested test", description: "Exercise nested checks", parameters: Type.Object({}),
            async execute(_id, _args, _signal, _update, ctx) {
              for (const [name, args] of [
                ["forbidden_io", {}], ["write", { path: "escaped.txt", content: "escaped" }],
                ["bash", { command: "printf escaped > escaped.txt" }],
              ] as const) {
                const result = await ctx.executeTool(name, args);
                assert.equal(result.isError, true, name);
                assert.match(JSON.stringify(result.result.content), name === "forbidden_io"
                  ? /Plan mode: .* is blocked/ : /Plan mode: .* is blocked|Tool .* not found/);
              }
              const recalled = await ctx.executeTool("artifact_recall", { id: "design" });
              assert.equal(recalled.isError, false);
              const read = await ctx.executeTool("read", { path: join(dir, "secret.txt") });
              assert.equal(read.isError, false);
              assert.match(JSON.stringify(read.result.content), /DO_NOT_ACCESS/);
              const research = await ctx.executeTool("readonly_io", {});
              assert.equal(research.isError, false);
              assert.match(JSON.stringify(research.result.content), /research worked/);
              nestedChecks = true;
              return { content: [{ type: "text", text: "Nested Plan guards verified" }], details: {} };
            } });
          if (reactivate) pi.on("before_agent_start", event => {
            event.systemPromptOptions.selectedTools.push("bash", "read", "codemode");
          });
          pi.registerProvider("plan-test", { api: model.api, baseUrl: model.baseUrl, apiKey: "local-test", models: [model],
            streamSimple: (_model: any, context: any) => {
              requests++;
              const declared = context.tools ?? context.messages.find((message: any) => message.role === "system")?.toolsAdded ?? [];
              if (requests === 1) {
                if (!reactivate) assert.ok(declared.some((t: any) => t.name === "artifact_save"), "Plan tools stay visible with codemode-only configured");
                assert.equal(declared.some((t: any) => t.name === "codemode"), reactivate);
              }
              assert.match(JSON.stringify(context), /Plan mode is active/);
              const call = (id: string, name: string, args: any) => ({ type: "toolCall", id, name, arguments: args });
              const content = requests === 1 ? [
                call("assess", "workflow_todo", { action: "skip", reason: "Local Plan guard regression" }),
              ] : requests === 2 ? [
                call("update", "artifact_save", { id: "design", title: "Design", type: "spec", content: "Refined during brainstorming" }),
                call("new", "artifact_save", { id: "new", title: "New", type: "plan", content: "New Plan artifact" }),
                call("shell", "bash", { command: "printf escaped > escaped.txt" }),
                call("read", "read", { path: "secret.txt" }),
                call("inspect", "bash", { command: "cat secret.txt | head -n 1" }),
                call("script", "codemode", { code: 'return await tools.bash({command:"printf escaped > escaped.txt"})' }),
                call("nested", "ask_user", {}),
              ] : [{ type: "text", text: "Brainstorm complete" }];
              const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content,
                stopReason: requests <= 2 ? "toolUse" : "stop",
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
              const stream = createAssistantMessageEventStream();
              stream.push({ type: "start", partial: message });
              stream.push({ type: "done", reason: message.stopReason, message });
              return stream;
            },
          });
        }],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const manager = SessionManager.create(dir, dir);
      manager.appendCustomEntry(ARTIFACT_TYPE, { id: "design", title: "Design", type: "spec", content: "Initial proposal", version: 1,
        createdBy: "main", createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z", tags: [] });
      ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: manager, model }));
      await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
      const original = session.getActiveToolNames();
      await session.prompt("/plan mode");
      assert.equal(requests, 0, "mode command itself never calls a model");
      assert.ok(session.getActiveToolNames().every(isPlanTool));
      await session.prompt("Grill @artifact:design");
      assert.equal(requests, 3, JSON.stringify(session.messages.at(-1)));
      assert.equal(nestedChecks, true, JSON.stringify(session.messages.filter((message: any) => message.role === "toolResult")));
      assert.equal(forbiddenCalls, 0);
      await assert.rejects(access(join(dir, "escaped.txt")));
      const results = manager.getBranch().filter((entry: any) => entry.type === "message" && entry.message.role === "toolResult") as any[];
      for (const id of ["shell", "script"]) {
        const result = results.find(entry => entry.message.toolCallId === id)?.message;
        assert.ok(result, id);
        assert.equal(result.isError, true, `${id}: ${JSON.stringify(result.content)}`);
        if (reactivate) assert.match(JSON.stringify(result.content), /Plan mode: .* is blocked/);
        assert.doesNotMatch(JSON.stringify(result.content), /DO_NOT_ACCESS/);
      }
      for (const id of ["new", "read", "inspect"]) {
        const result = results.find(entry => entry.message.toolCallId === id)?.message;
        assert.ok(result, id);
        assert.notEqual(result.isError, true, `${id}: ${JSON.stringify(result.content)}`);
        if (id !== "new") assert.match(JSON.stringify(result.content), /DO_NOT_ACCESS/);
      }
      assert.equal(recordsFromBranch(manager.getBranch()).get("design")?.version, 2);
      assert.equal(recordsFromBranch(manager.getBranch()).has("new"), true);
      assert.equal(planModeFromBranch(manager.getBranch())?.enabled, true);
      const saved = manager.getSessionFile();
      assert.ok(saved);
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      session = undefined;
      await loader.reload();
      ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings,
        sessionManager: SessionManager.open(saved!), model }));
      await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
      assert.equal(planModeFromBranch(session.sessionManager.getBranch())?.enabled, true);
      assert.ok(session.getActiveToolNames().every(isPlanTool), "saved Plan restrictions restore in a fresh extension runtime");
      await session.prompt("/plan off");
      assert.deepEqual(session.getActiveToolNames(), original);
      assert.equal(planModeFromBranch(session.sessionManager.getBranch())?.enabled, false);
      assert.deepEqual(errors, []);
    } finally {
      session?.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
