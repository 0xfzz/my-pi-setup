import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import modes from "../extensions/modes.ts";
import { planModeFromBranch } from "../lib/plan/plan-mode.ts";

for (const cancel of [false, true]) {
  test(`real native shell blocks Plan through command and Alt+M until ${cancel ? "cancellation" : "completion"}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mode-shell-"));
    let session: any;
    let editor: any;
    let finish: () => void = () => {};
    let started: () => void = () => {};
    const running = new Promise<void>(resolve => { started = resolve; });
    const errors: unknown[] = [];
    const notices: string[] = [];
    let remoteCalls = 0;
    try {
      const settings = SettingsManager.inMemory({ cacheWarming: "off" });
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [modes, pi => {
          // A later remote-shell extension must retain ownership of execution.
          pi.on("user_bash", () => ({ operations: { async exec(_command, _cwd, options) {
            remoteCalls++;
            started();
            await new Promise<void>((resolve, reject) => {
              finish = resolve;
              options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
            return { exitCode: 0 };
          } } }));
        }],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings,
        sessionManager: SessionManager.inMemory(dir) }));
      const color = (text: string) => text;
      await session.bindExtensions({ mode: "tui", onError: (error: unknown) => errors.push(error), uiContext: {
        setWidget() {}, notify(text: string) { notices.push(text); },
        setEditorComponent(factory: any) { editor = factory({ requestRender() {}, terminal: { rows: 30, columns: 100 } }, {
          borderColor: color, selectList: { selectedPrefix: color, selectedText: color, description: color, scrollInfo: color, noMatch: color },
        }, { matches: () => false }); },
      } as any });
      editor.onSubmit = async (text: string) => {
        const command = text.replace(/^!!?/, "");
        const event = await session.extensionRunner.emitUserBash({ type: "user_bash", command, cwd: dir, excludeFromContext: true });
        assert.ok(event?.operations, "the cooperating remote shell owns user_bash");
        return session.executeBash(command, undefined, { excludeFromContext: true, operations: event.operations });
      };
      editor.setText("Keep this draft");
      const submission = editor.onSubmit("!!inert gated command");
      await running;
      assert.equal(session.isIdle, true);
      assert.equal(session.isBashRunning, true);
      for (const command of ["/plan on", "/mode plan"]) {
        await session.prompt(command);
        assert.notEqual(planModeFromBranch(session.sessionManager.getBranch())?.enabled, true);
        assert.match(notices.at(-1)!, /shell command/);
      }
      editor.handleInput("\x1bm"); // Normal -> Plan must fail.
      assert.notEqual(planModeFromBranch(session.sessionManager.getBranch())?.enabled, true);
      assert.equal(editor.getText(), "Keep this draft");
      if (cancel) session.abortBash(); else finish();
      await submission;
      assert.equal(session.isBashRunning, false);
      await session.prompt("/plan on");
      assert.equal(planModeFromBranch(session.sessionManager.getBranch())?.enabled, true);
      assert.equal(remoteCalls, 1);
      assert.deepEqual(errors, []);
    } finally {
      finish();
      editor?.setText("");
      session?.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
