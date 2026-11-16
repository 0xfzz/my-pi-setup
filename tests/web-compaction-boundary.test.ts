// A custom compactor's entry must reach the browser.
//
// Pi has two compaction paths, and they announce themselves differently:
//
//   1. pi's own (manual /compact, the context threshold, overflow recovery):
//      `compact()` appends the entry and emits `compaction_start` /
//      `compaction_end`. The web's own compact route covers the manual case.
//
//   2. A `turn_end` boundary draft from an extension — the mechanism this
//      repo's VCC controller uses (lib/vcc/controller.ts returns
//      `{ type: "compaction" }` entries from a turn_end handler). Pi commits
//      those drafts through `_commitBoundaryDrafts` and announces each one as
//      an `entry_appended`, with no compaction_start/compaction_end at all.
//
// The second path is the override: an extension says how the context is
// summarized, and pi still persists and projects it. `wire.ts` drops
// `entry_appended` except for bash, so before this test the browser never
// learned a compaction had happened and the transcript silently jumped.
//
// This drives the real pi boundary pipeline with a scripted model (no
// inference) and asserts that the event pi emits projects to the browser
// signal the client acts on.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { toClientAgentEvent } from "../web/core/server/wire.ts";

const MODEL: any = {
  id: "compaction-boundary-test",
  name: "Compaction boundary test",
  provider: "compaction-boundary-test",
  api: "compaction-boundary-scripted",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1_000,
};

/** A model that replies with one short text message and no tool calls. */
function scriptedModel(): any {
  return () => {
    const stream = createAssistantMessageEventStream();
    const message: any = {
      role: "assistant",
      api: MODEL.api,
      provider: MODEL.provider,
      model: MODEL.id,
      timestamp: Date.now(),
      content: [{ type: "text", text: "Acknowledged." }],
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: message.stopReason, message });
    return stream;
  };
}

test("a turn_end boundary compaction reaches the browser as compaction_applied", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-compaction-boundary-"));
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 5_000 },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const events: Array<{ type: string; entry?: { type?: string } }> = [];
  let session: any;  try {
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        // The override under test: an extension compacts by appending a
        // boundary draft, exactly like lib/vcc/controller.ts does.
        (pi) => {
          pi.registerProvider("compaction-boundary-test", {
            api: MODEL.api,
            baseUrl: MODEL.baseUrl,
            apiKey: "local-test-not-a-secret",
            models: [MODEL],
            streamSimple: scriptedModel(),
          });
          pi.on("turn_end", (event: any) => ({
            entries: [
              ...event.entries,
              {
                type: "compaction" as const,
                summary: "The user said hello; the assistant acknowledged it.",
                firstKeptEntryId: event.entries[0]?.id,
                details: { compactor: "test-boundary" },
              },
            ],
          }));
        },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);

    const created = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager: SessionManager.create(dir, dir),
      model: MODEL,
    });
    session = created.session;
    await session.bindExtensions({});
    session.subscribe((event: { type: string; entry?: { type?: string } }) => { events.push(event); });

    await session.prompt("hello");

    // pi announces the committed boundary draft as an appended entry.
    const appended = events.filter(
      (event) => event.type === "entry_appended" && event.entry?.type === "compaction",
    );
    assert.equal(appended.length, 1, "the boundary compaction is announced as an appended entry");
    // pi's own paths announce compaction_start/compaction_end instead; the
    // boundary path must not pretend to be one of them.
    assert.equal(
      events.filter((event) => event.type === "compaction_start").length,
      0,
      "a boundary compaction never emits compaction_start",
    );

    // …and that appended entry is what the browser's wire turns into its signal.
    assert.deepEqual(toClientAgentEvent(appended[0]), { type: "compaction_applied" });

    // The entry is persisted, so the client's follow-up history read paints
    // the marker with the summary the compactor chose.
    const branch = session.sessionManager.getBranch();
    const entry = branch.find((candidate: { type?: string }) => candidate.type === "compaction") as
      | { summary?: string }
      | undefined;
    assert.equal(entry?.summary, "The user said hello; the assistant acknowledged it.");
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
