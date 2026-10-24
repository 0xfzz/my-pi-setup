import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentSystemMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import modes from "../extensions/modes.ts";
import artifacts from "../extensions/artifacts.ts";
import { INPUT_MODE_CONTEXT_TYPE, planModeFromBranch } from "../lib/plan-mode.ts";

for (const exit of ["/plan off", "/mode normal", "Shift+Tab"]) {
  for (const [resume, compact] of [[false, false], [false, true], [true, false], [true, true]] as const) {
    test(`real Pi explicitly briefs Normal and permits implementation after ${exit}${resume ? " on a resumed Plan session" : ""}${compact ? " with a stale Plan compaction summary" : ""}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-mode-transition-"));
      let session: any;
      let editorFactory: any;
      let widgetFactory: any;
      let stage: "normal-before" | "plan" | "normal-after" = "normal-before";
      let wrote = false;
      let requests = 0;
      const errors: unknown[] = [];
      const model: any = { id: "mode-transition-local", name: "Mode transition local", provider: "mode-transition-test", api: "mode-transition-scripted",
        baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      try {
        const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false }, cacheWarming: "off" });
        const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [artifacts, modes, pi => {
            pi.on("session_before_compact", event => ({ compaction: {
              summary: "Historical summary: Plan mode is active; implementation is forbidden. Ask the user to run /plan off.",
              firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
            } }));
            pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "local-test", models: [model],
              streamSimple: (_model: any, context: any) => {
                requests++;
                // Replay structured system deltas, rather than matching historical instructions.
                const current = getCurrentSystemMessage(context.messages);
                const prompt = getCurrentSystemPrompt(context.messages);
                // Check the provider-bound conversation, not just reconstructed
                // system sections: a live reminder must win over old replies and
                // compaction summaries on EVERY request, including the write follow-up.
                const reminders = context.messages.filter((message: any) => JSON.stringify(message.content).includes("<current-input-mode>"));
                assert.equal(reminders.length, 1);
                assert.equal(reminders[0], context.messages.at(-1));
                assert.match(JSON.stringify(reminders[0].content), /supersedes historical mode instructions/);
                assert.match(JSON.stringify(reminders[0].content), stage === "plan" ? /Plan mode is ON/ : /Plan mode is OFF/);
                if (stage === "normal-after" && compact) {
                  assert.match(JSON.stringify(context.messages), /Historical summary: Plan mode is active/);
                }
                if (stage === "plan") {
                  assert.match(current?.sections?.input_mode ?? "", /Current input mode: Plan/);
                  assert.match(current?.sections?.plan_mode ?? "", /Plan mode is active/);
                } else {
                  assert.match(current?.sections?.input_mode ?? "", /Current input mode: Normal/);
                  assert.match(current?.sections?.input_mode ?? "", /Plan mode is OFF/);
                  assert.equal(current?.sections?.plan_mode, undefined);
                  assert.doesNotMatch(prompt, /Plan mode is active/);
                }
                const implement = stage === "normal-after" && !wrote;
                if (implement) wrote = true;
                const content = implement
                  ? [{ type: "toolCall", id: "normal-write", name: "write", arguments: { path: join(dir, "normal.txt"), content: "Normal implementation works" } }]
                  : [{ type: "text", text: stage === "plan" ? "Plan mode is active; we are brainstorming only." : "Normal mode confirmed." }];
                const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content,
                  stopReason: implement ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
                const stream = createAssistantMessageEventStream();
                stream.push({ type: "start", partial: message });
                stream.push({ type: "done", reason: message.stopReason, message });
                return stream;
              },
            });
          }],
        });
        const bind = async (manager: SessionManager) => {
          await loader.reload();
          assert.deepEqual(loader.getExtensions().errors, []);
          ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: manager, model }));
          await session.bindExtensions({ mode: "tui", onError: (error: unknown) => errors.push(error), uiContext: {
            setWidget(key: string, factory: any) { if (key === "input-modes") widgetFactory = factory; },
            setEditorComponent(factory: any) { editorFactory = factory; },
            addAutocompleteProvider() {}, setStatus() {}, notify() {},
          } as any });
        };
        await bind(SessionManager.create(dir, dir));
        const original = [...session.getActiveToolNames()];
        await session.prompt("Confirm current mode.");
        assert.notEqual(session.messages.at(-1)?.stopReason, "error", session.messages.at(-1)?.errorMessage);
        await session.prompt("/plan mode");
        stage = "plan";
        await session.prompt("Brainstorm in Plan mode.");
        assert.notEqual(session.messages.at(-1)?.stopReason, "error", session.messages.at(-1)?.errorMessage);
        if (compact) await session.compact();
        if (resume) {
          const saved = session.sessionManager.getSessionFile();
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          session.dispose(); session = undefined;
          await bind(SessionManager.open(saved));
        }
        if (exit === "Shift+Tab") {
          const color = (text: string) => text;
          const editor = editorFactory({ requestRender() {}, terminal: { rows: 30, columns: 120 } }, {
            borderColor: color, selectList: { selectedPrefix: color, selectedText: color, description: color, scrollInfo: color, noMatch: color },
          }, { matches: () => false });
          editor.handleInput("\x1b[Z"); // plan → orchestrator (orchestrator is cycleable)
          editor.handleInput("\x1b[Z"); // orchestrator → normal
        } else {
          await session.prompt(exit);
        }
        assert.equal(planModeFromBranch(session.sessionManager.getBranch())?.enabled, false);
        assert.deepEqual(session.getActiveToolNames(), original);
        assert.match(widgetFactory({}, { fg: (_token: string, text: string) => text, bold: (text: string) => text }).render(120).join("\n"), /\[ 󰚥 Normal \]/u);
        stage = "normal-after";
        await session.prompt("Implement the requested local fixture now.");
        assert.notEqual(session.messages.at(-1)?.stopReason, "error", session.messages.at(-1)?.errorMessage);
        assert.equal(await readFile(join(dir, "normal.txt"), "utf8"), "Normal implementation works");
        assert.equal(requests, 4);
        assert.equal(session.sessionManager.getBranch().some((entry: any) =>
          entry.type === "custom_message" && entry.customType === INPUT_MODE_CONTEXT_TYPE), false,
          "live reminders must not accumulate in persisted history");
        assert.deepEqual(errors, []);
      } finally {
        session?.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}
