import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, CustomEditor, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { CombinedAutocompleteProvider, visibleWidth } from "@earendil-works/pi-tui";
import artifactsExtension from "../extensions/artifacts.ts";
import modesExtension from "../extensions/modes.ts";
import { createArtifactAutocompleteProvider } from "../lib/artifact-mentions.ts";
import { ARTIFACT_TYPE, type Artifact } from "../lib/artifact-state.ts";

const artifact: Artifact = {
  id: "runtime-spec", title: "Runtime spec", type: "spec", content: "Exact saved artifact content.",
  version: 3, tags: [], createdBy: "main", createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z",
};

test("real Pi input pipeline sends a versioned mention snapshot to the model and session history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-artifact-mention-"));
  let session: any;
  try {
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const errors: unknown[] = [];
    const requests: any[] = [];
    const model = {
      id: "artifact-local-test", name: "Artifact local test", provider: "artifact-test", api: "artifact-scripted",
      baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"] as ("text")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
    };
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [artifactsExtension, pi => {
        pi.registerProvider("artifact-test", {
          api: model.api, baseUrl: model.baseUrl, apiKey: "local-test-not-a-secret", models: [model],
          streamSimple: ((_model: any, context: any) => {
            requests.push(context);
            const stream = createAssistantMessageEventStream();
            const message: any = {
              role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
              content: [{ type: "text", text: "Read the attached spec." }], stopReason: "stop",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            };
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: "stop", message });
            return stream;
          }) as any,
        });
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const manager = SessionManager.inMemory(dir);
    manager.appendCustomEntry(ARTIFACT_TYPE, artifact);
    ({ session } = await createAgentSession({
      cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: manager, model,
    }));
    await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
    await session.prompt("Review @artifact:runtime-spec");
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 1);
    const userRequest = requests[0].messages.find((message: any) => message.role === "user");
    assert.doesNotMatch(JSON.stringify(userRequest.content), /Exact saved artifact content/);
    assert.match(JSON.stringify(userRequest.content), /v3, spec/);
    assert.match(JSON.stringify(userRequest.content), /artifact_recall/);
    assert.match(JSON.stringify(userRequest.content), /@artifact:runtime-spec/);
    const saved = manager.getBranch().find((entry: any) => entry.type === "message" && entry.message.role === "user") as any;
    assert.doesNotMatch(JSON.stringify(saved.message.content), /Exact saved artifact content/);
    assert.match(JSON.stringify(saved.message.content), /v3, spec/);
    assert.match(JSON.stringify(saved.message.content), /artifact_recall/);
    manager.appendCustomEntry(ARTIFACT_TYPE, { ...artifact, version: 4, content: "Updated saved artifact." });
    assert.doesNotMatch(JSON.stringify(saved.message.content), /Updated saved artifact/);
    assert.doesNotMatch(JSON.stringify(saved.message.content), /v4/);
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("real mode editor Tab-completes artifacts without losing Alt+M or narrow rendering", async () => {
  const hooks = new Map<string, Function>();
  let factory: any;
  modesExtension({
    on: (name: string, fn: Function) => hooks.set(name, fn), registerCommand() {},
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, appendEntry() {},
  } as any);
  hooks.get("session_start")!({}, {
    mode: "tui", isIdle: () => true, sessionManager: { getBranch: () => [] },
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, appendEntry() {},
    ui: { setWidget() {}, setEditorComponent(fn: any) { factory = fn; } },
  });
  const color = (text: string) => text;
  const editor: any = factory({ requestRender() {}, terminal: { rows: 30, columns: 80 } }, {
    borderColor: color,
    selectList: { selectedPrefix: color, selectedText: color, description: color, scrollInfo: color, noMatch: color },
  }, { matches: () => false });
  editor.setAutocompleteProvider(createArtifactAutocompleteProvider(
    new CombinedAutocompleteProvider([], "/tmp"), () => new Map([[artifact.id, artifact]]),
  ));
  editor.setText("Review @artifact:runt");
  editor.handleInput("\t");
  // Await the actual editor's asynchronous request rather than using timer-based sleeps.
  await editor.autocompleteRequestTask;
  assert.equal(editor.getText(), "Review @artifact:runtime-spec ");
  for (const width of [20, 40, 80]) {
    for (const line of editor.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  const submitted: string[] = [];
  editor.onSubmit = (text: string) => submitted.push(text);
  editor.handleInput("\x1bm");
  assert.equal(editor.getText(), "Review @artifact:runtime-spec ");
  editor.onSubmit(editor.getText());
  assert.deepEqual(submitted, ["Review @artifact:runtime-spec "]);
  hooks.get("session_shutdown")!({});
});

test("typing @artifact naturally opens the dropdown without Tab or a colon", { timeout: 2000 }, async t => {
  const color = (text: string) => text;
  const editor: any = new CustomEditor({ requestRender() {}, terminal: { rows: 30, columns: 100 } } as any, {
    borderColor: color,
    selectList: { selectedPrefix: color, selectedText: color, description: color, scrollInfo: color, noMatch: color },
  }, { matches: () => false } as any);
  t.after(() => editor.setText(""));
  const provider = createArtifactAutocompleteProvider(
    new CombinedAutocompleteProvider([], "/tmp"), () => new Map([[artifact.id, artifact]]),
  );
  let onRequest: () => void = () => {};
  editor.setAutocompleteProvider({
    ...provider,
    async getSuggestions(...args: Parameters<typeof provider.getSuggestions>) {
      const result = await provider.getSuggestions(...args);
      onRequest();
      return result;
    },
  });
  for (const chunk of ["Review @artifact", ":", "runtime"]) {
    const requested = new Promise<void>(resolve => { onRequest = resolve; });
    for (const char of chunk) editor.handleInput(char);
    // Wait for the editor's real natural/debounced request, not a forced Tab completion.
    await requested;
    await editor.autocompleteRequestTask;
    assert.equal(editor.isShowingAutocomplete(), true, `dropdown visible after ${editor.getText()}`);
    assert.match(editor.render(100).join("\n"), /@artifact:runtime-spec/);
  }
  editor.handleInput("\t");
  assert.equal(editor.getText(), "Review @artifact:runtime-spec ");
});
