import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import artifactsExtension from "../extensions/artifacts.ts";

/**
 * Boot the artifact tools in a real Pi runtime and drive them through Pi's own
 * tool dispatcher (`ctx.executeTool`), not by calling `execute` directly.
 *
 * The unit tests in `artifact-edit.test.ts` invoke `execute` with a fake context,
 * which cannot catch two classes of failure that only exist under real Pi:
 * a TypeBox schema Pi refuses to register, and arguments that Pi's validation
 * rewrites or rejects before the handler ever sees them. Both regressions in this
 * area (the missing `sv2_handoff` allowlist entry, and `artifact_edit` omitting
 * its placement fields) were invisible to hand-rolled harnesses.
 *
 * A nested tool is used because that is the only in-process way to reach
 * `ctx.executeTool`; it also proves the new tools are callable from another tool,
 * which is what the supervisor's review path relies on.
 */
test("real Pi loads the artifact tools and they work through the tool pipeline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-artifact-runtime-"));
  let session: any;
  const errors: unknown[] = [];
  const observed: Record<string, string> = {};
  let requests = 0;
  let exercised = false;
  const model: any = {
    id: "artifact-tools", name: "Artifact tools", provider: "artifact-tools-test", api: "artifact-scripted",
    baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 2000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };

  try {
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [artifactsExtension, pi => {
        pi.registerTool({
          name: "exercise_artifacts", label: "Exercise artifacts", description: "Drive the artifact tools",
          parameters: Type.Object({}),
          async execute(_id: string, _args: any, _signal: any, _update: any, ctx: any) {
            const run = async (name: string, args: any) => {
              const outcome = await ctx.executeTool(name, args);
              assert.notEqual(outcome.isError, true, `${name} failed: ${JSON.stringify(outcome.result?.content)}`);
              return String(outcome.result?.content?.[0]?.text ?? "");
            };
            const save = await run("artifact_save", {
              id: "runtime-doc", title: "Runtime doc", type: "spec",
              content: "# Goal\nalpha\nbeta\ngamma\ndelta\nepsilon",
            });
            observed.save = save;
            observed.range = await run("artifact_recall", { id: "runtime-doc", offset: 3, limit: 2 });
            observed.search = await run("artifact_search", { query: "gamma" });
            observed.edit = await run("artifact_edit", { id: "runtime-doc", mode: "replace", oldString: "beta", newString: "BETA" });
            observed.full = await run("artifact_recall", { id: "runtime-doc" });
            observed.appended = await run("artifact_edit", { id: "runtime-doc", mode: "append", content: "zeta" });
            exercised = true;
            return { content: [{ type: "text", text: "artifact tools exercised" }], details: {} };
          },
        });
        pi.registerProvider("artifact-tools-test", {
          api: model.api, baseUrl: model.baseUrl, apiKey: "local-test", models: [model],
          streamSimple: (_m: any) => {
            requests++;
            const message: any = {
              role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
              content: requests === 1
                ? [{ type: "toolCall", id: "go", name: "exercise_artifacts", arguments: {} }]
                : [{ type: "text", text: "done" }],
              stopReason: requests === 1 ? "toolUse" : "stop",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            };
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: message.stopReason, message });
            return stream;
          },
        });
      }],
    });
    await loader.reload();
    // An invalid TypeBox schema surfaces here rather than at the call site.
    assert.deepEqual(loader.getExtensions().errors, [], "the artifact extension must load cleanly");

    const manager = SessionManager.create(dir, dir);
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: manager, model }));
    await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });

    // All four artifact tools must be registered and active, so a default loadout
    // offers them without any mode or switch being involved.
    const active = session.getActiveToolNames();
    for (const name of ["artifact_save", "artifact_edit", "artifact_search", "artifact_recall", "artifact_list"]) {
      assert.ok(active.includes(name), `${name} must be registered and active`);
    }

    await session.prompt("exercise the artifact tools");
    assert.equal(exercised, true, JSON.stringify(session.messages.at(-1)));
    assert.deepEqual(errors, []);

    // The range read returns only the requested lines, with a citable gutter.
    assert.match(observed.range, /Lines 3-4 of 6\./);
    assert.match(observed.range, /3│ beta/);
    assert.match(observed.range, /4│ gamma/);
    assert.doesNotMatch(observed.range, /5│ delta/);
    assert.doesNotMatch(observed.range, /2│ alpha/);

    // Search reports a usable position inside the body.
    assert.match(observed.search, /\[runtime-doc\].*line 4/);
    assert.match(observed.search, /artifact_recall\(\{ id: "runtime-doc", offset: 4/);

    // The edit patched one line and bumped the version.
    assert.match(observed.edit, /edited \(v2, 6 lines\)/);
    assert.match(observed.edit, /committed to the workspace catalog/);

    // Untouched lines survive a partial edit, which is the whole point: only the
    // matched word changed, and every other line is byte-identical without having
    // been retyped.
    assert.match(observed.full, /# Goal\nalpha\nBETA\ngamma\ndelta\nepsilon/);
    assert.doesNotMatch(observed.full, /\bbeta\b/);

    // And the artifact is genuinely versioned state on the branch.
    assert.match(observed.appended, /edited \(v3, 7 lines\)/);
    assert.match(observed.appended, /Appended 1 line/);
    assert.match(
      (await session.getActiveToolNames()).join(","),
      /artifact_edit/,
      "registration is stable across a completed turn",
    );
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
