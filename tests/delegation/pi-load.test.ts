import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import subagentV2 from "../../extensions/agent.ts";

test("real Pi loads subagent-v2 with zero extension errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sv2-load-"));
  const settings = SettingsManager.inMemory({ cacheWarming: "off" });
  const notices: string[] = [];
  try {
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [subagentV2, (pi: any) => {
        for (const n of ["read", "bash", "artifact_save", "ask_user"]) {
          pi.registerTool({ name: n, label: n, description: n, parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "x" }], details: undefined }; } });
        }
      }],
    });
    await loader.reload();
    const errors = loader.getExtensions().errors;
    console.log("EXTENSION ERRORS:", JSON.stringify(errors.map(String), null, 1));
    assert.deepEqual(errors.map(String), []);

    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(dir) });
    await session.bindExtensions({ mode: "tui", onError: (e: unknown) => errors.push(e as { path: string; error: string }), uiContext: { setWidget() {}, setEditorComponent() {}, setStatus() {}, addAutocompleteProvider() {}, notify(t: string) { notices.push(t); }, async confirm() { return false; }, async input() { return ""; }, async select() { return ""; } } as any });

    const names = [...session.getActiveToolNames()].sort();
    console.log("ACTIVE:", JSON.stringify(names.filter((n: string) => n.startsWith("agent_"))));
    for (const t of ["agent_spawn", "agent_escalate", "agent_running", "agent_steer"]) {
      assert.ok(names.includes(t), `${t} must be registered and active`);
    }
    assert.equal(names.includes("agent_route"), false, "agent_route is retired; /steer owns text routing");
    const commands = session.extensionRunner.getRegisteredCommands?.() ?? [];
    console.log("COMMANDS:", JSON.stringify((commands as any[]).map((c) => c.name).filter((n: string) => n === "agent" || n === "steer")));
    console.log("ERRORS:", JSON.stringify(errors.map(String)));
    session.dispose();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
