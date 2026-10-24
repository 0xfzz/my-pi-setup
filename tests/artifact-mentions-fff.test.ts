import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { ARTIFACT_TYPE } from "../lib/artifact-state.ts";
import { PLAN_MODE_TYPE } from "../lib/plan-mode.ts";

// Opt in to the real installed native FFF extension without adding it as a project dependency.
const fffPath = process.env.PI_FFF_EXTENSION_PATH;

test("real FFF must register before artifacts to preserve both @ suggestion sources", { skip: !fffPath }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-artifact-fff-"));
  const previous = { frecency: process.env.FFF_FRECENCY_DB, history: process.env.FFF_HISTORY_DB, mode: process.env.PI_FFF_MODE };
  process.env.PI_FFF_MODE = "tools-and-ui";
  try {
    for (const fffFirst of [false, true]) {
      const dir = join(root, fffFirst ? "correct-order" : "conflicting-order");
      await mkdir(dir);
      await writeFile(join(dir, "artifact-guide.md"), "A file, not an artifact.");
      process.env.FFF_FRECENCY_DB = join(dir, "frecency.db");
      process.env.FFF_HISTORY_DB = join(dir, "history.db");
      const artifactsPath = resolve(import.meta.dirname, "../extensions/artifacts.ts");
      const settings = SettingsManager.inMemory({ cacheWarming: "off" });
      const loader = new DefaultResourceLoader({
        cwd: dir, agentDir: dir, settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: fffFirst ? [fffPath!, artifactsPath] : [artifactsPath, fffPath!],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const manager = SessionManager.inMemory(dir);
      manager.appendCustomEntry(ARTIFACT_TYPE, {
        id: "saved-spec", title: "Saved spec", type: "spec", content: "Saved artifact content.",
        version: 1, tags: [], createdBy: "main", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      const { session } = await createAgentSession({
        cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: manager,
      });
      const factories: ((current: AutocompleteProvider) => AutocompleteProvider)[] = [];
      const errors: unknown[] = [];
      const notifications: string[] = [];
      try {
        await session.bindExtensions({
          mode: "tui", onError: error => errors.push(error),
          uiContext: {
            addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider) { factories.push(factory); },
            setWidget() {}, setStatus() {}, notify(message: string) { notifications.push(message); },
          } as any,
        });
        assert.deepEqual(errors, []);
        assert.deepEqual(notifications, [], "FFF must initialize successfully, not silently fall back");
        assert.equal(factories.length, 2);
        const provider = factories.reduce((current, factory) => factory(current), new CombinedAutocompleteProvider([], dir) as AutocompleteProvider);
        for (const text of ["@", "@artifact"]) {
          const result = await provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal });
          const values = result?.items.map(item => item.value) ?? [];
          if (!fffFirst) {
            assert.ok(values.includes("@artifact-guide.md"), "reproduces FFF taking the @ menu");
            assert.ok(!values.includes("@artifact:saved-spec"), "the original load order hides artifacts");
          } else {
            assert.ok(values.includes("@artifact:saved-spec"), "correct order exposes saved artifacts");
            assert.equal(values.includes("@artifact-guide.md"), text === "@", "bare @ retains FFF files; @artifact is artifact-only");
          }
        }
        if (fffFirst) {
          const text = "@artifact-guide";
          const result = await provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal });
          assert.ok(result?.items.some(item => item.value === "@artifact-guide.md"), "ordinary FFF file filtering still works");
          const selected = result!.items.find(item => item.value === "@artifact-guide.md")!;
          assert.equal(provider.applyCompletion([text], 0, text.length, selected, result!.prefix).lines[0], "@artifact-guide.md ");
          manager.appendCustomEntry(PLAN_MODE_TYPE, { enabled: true, previousTools: [] });
          for (const query of ["@", "@artifact"]) {
            const planResults = await provider.getSuggestions([query], 0, query.length, { signal: new AbortController().signal });
            assert.deepEqual(planResults?.items.map(item => item.value), ["@artifact:saved-spec"], "Plan never includes FFF files");
          }
          assert.equal(await provider.getSuggestions(["./"], 0, 2, { signal: new AbortController().signal }), null);
        }
      } finally {
        await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
    }
  } finally {
    for (const [name, value] of [["FFF_FRECENCY_DB", previous.frecency], ["FFF_HISTORY_DB", previous.history], ["PI_FFF_MODE", previous.mode]]) {
      if (value === undefined) delete process.env[name!];
      else process.env[name!] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
