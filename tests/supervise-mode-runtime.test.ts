import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import modes from "../extensions/modes.ts";
import { DELEGATION_TOOLS, RETIRED_V1_TOOLS } from "../lib/delegation-tools.ts";
import { CORE_REVIEW_TOOLS, DEFERRED_ORCH_TOOLS, isSupervisorTool } from "../lib/supervise-mode.ts";

/**
 * Boot the LIVE gate in a real Pi runtime.
 *
 * The regression this pins down was only observable under a real load. Every unit
 * test passed while `lib/supervise-mode.ts` — the copy that `extensions/modes.ts`
 * actually imports — was missing `orch_handoff` and `orch_escalate`. Unit tests
 * called `isSupervisorTool` against a hand-written tool list, so they never asked
 * `modes.ts` what it does to a real session's loadout.
 *
 * The debug session (01a16ca1) shows the consequence: `orch_spawn` survived while
 * `orch_handoff` was stripped, leaving a spawn tool whose mandatory `handoffId`
 * precondition no tool could satisfy. The orchestrator probed `tool_search`, got
 * "No matching tools found", then called the v1 `subagent` tool — no handoff spec,
 * one shared artifact catalog, no escalation ladder.
 *
 * So this test asserts the three things that actually matter, on the surface the
 * model sees: the tools declared to the model, the active loadout, and whether a
 * v1 delegation call is refused at execution time.
 */
test("real Pi supervise mode keeps orch_handoff/orch_escalate and refuses v1 delegation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-supervise-runtime-"));
  let session: any;
  const errors: unknown[] = [];
  let requests = 0;
  const model: any = {
    id: "sup-local", name: "Sup local", provider: "sup-test", api: "sup-scripted",
    baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 2000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  try {
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [modes, pi => {
        // A loadout shaped like the failing session's: read-only inspection, both
        // delegation surfaces, and the direct-implementation tools the mode forbids.
        for (const name of ["read", "bash", "edit", "write", "artifact_save", "artifact_edit", "artifact_search", "artifact_recall", "artifact_list", ...DELEGATION_TOOLS.map(tool => tool.name)]) {
          pi.registerTool({
            name, label: name, description: name, parameters: Type.Object({}),
            async execute() { return { content: [{ type: "text", text: `${name} ran` }], details: {} }; },
          });
        }
        pi.registerProvider("sup-test", {
          api: model.api, baseUrl: model.baseUrl, apiKey: "local-test", models: [model],
          streamSimple: (_m: any, context: any) => {
            requests++;
            const call = (id: string, name: string, args: any) => ({ type: "toolCall", id, name, arguments: args });
            const content: any[] = requests === 1
              // The orchestrator's real first move: author the spec, then delegate.
              ? [
                  call("handoff", "orch_handoff", { scope: "net-retry", goal: "g", acceptanceCriteria: ["a"], laneFiles: ["src/net/client.ts"] }),
                  // A direct write, attempted on purpose: the mode must refuse it.
                  call("sneak", "write", { path: "sneaky.txt", content: "x" }),
                ]
              : [{ type: "text", text: "Supervise turn complete" }];
            const message: any = {
              role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content,
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
    assert.deepEqual(loader.getExtensions().errors, [], "the live gate must load cleanly");

    const manager = SessionManager.create(dir, dir);
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: manager, model }));
    await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });

    await session.prompt("/supervise on");
    // The mode command alone must never reach a model.
    assert.equal(requests, 0, "the /supervise command is local");
    const active = session.getActiveToolNames();
    // REACHABILITY, not declaration.
    //
    // The loadout declares every permitted tool except the ones registered with
    // `exposure: "deferred"`. Withholding anything else is permanent: `tool_search`
    // only indexes tools that were never declared *by exposure*, so a `direct` tool
    // the mode removed cannot be found again. Session `01a16c5b` is the evidence:
    // thirteen searches for a spawn tool the mode had just un-declared, thirteen
    // "No matching tools found". Reachability here therefore means "declared, or
    // deferred on purpose".
    const reachable = (name: string) => active.includes(name) || DEFERRED_ORCH_TOOLS.has(name);
    for (const name of ["orch_handoff", "orch_spawn", "orch_escalate", "orch_review", "orch_running", "orch_steer", "read", "artifact_save", "artifact_edit", "artifact_search", "artifact_recall", "artifact_list"]) {
      assert.ok(reachable(name), `${name} must be reachable in supervise mode`);
    }
    // Host tools the review reads with are direct-exposure and cannot be deferred,
    // so they must be actively declared — not merely permitted.
    for (const name of ["read", "artifact_recall", "artifact_list"]) {
      assert.ok(active.includes(name), `${name} is direct-exposure: undeclaring it makes it unreachable`);
    }
    // The authoring → observe → verify → judge loop is called every turn, so paying
    // its schema is cheaper than a tool_search round trip for each of them. Only the
    // tools THIS fixture registers are asserted: `tool_search`, `ask_user` and
    // `orch_close` are host/fixture-dependent, and their declaration is pinned by
    // `tests/orchestrator/loadout-budget.test.ts` against the real registration.
    const declared = ["orch_handoff", "orch_spawn", "orch_running", "orch_brief", "orch_check", "orch_review", "orch_escalate"];
    for (const name of declared) {
      assert.ok(DELEGATION_TOOLS.some(tool => tool.name === name), `${name} is asserted here but this fixture does not register it`);
      assert.ok(active.includes(name), `${name} must be declared, not deferred`);
    }
    for (const name of RETIRED_V1_TOOLS) {
      assert.equal(active.includes(name), false, `${name} must never be registered`);
    }
    for (const name of ["edit", "write"]) {
      assert.equal(active.includes(name), false, `${name} must be blocked in supervise mode`);
    }

    await session.prompt("Author the handoff, then delegate");
    assert.equal(requests, 2, JSON.stringify(session.messages.at(-1)));

    // What the model was actually told it could call. This is the surface that
    // silently lost orch_handoff: the same tools Pi had registered were filtered out
    // of the system prompt's tool section.
    // The declared-tools surface: what this session will actually offer the model.
    // (Pi 1.4 does not expose a `tools` array on the provider context, so the
    // authoritative observable is the session's active tool set, which is what
    // `before_agent_start` writes and `tool_call` enforces.)
    for (const name of ["orch_handoff", "orch_escalate", "orch_spawn"]) {
      assert.ok(active.includes(name), `${name} must be offered to the model`);
    }
    assert.equal(active.includes("edit"), false, "edit must not be offered");

    // Authoring the spec worked...
    const results = manager.getBranch()
      .filter((entry: any) => entry.type === "message" && entry.message.role === "toolResult")
      .map((entry: any) => entry.message);
    const handoff = results.find((result: any) => result.toolCallId === "handoff");
    assert.ok(handoff, "orch_handoff must execute");
    assert.notEqual(handoff.isError, true, JSON.stringify(handoff.content));
    assert.match(JSON.stringify(handoff.content), /orch_handoff ran/);

    // ...and a direct write was refused: supervise never implements. Because
    // `write` is absent from the declared loadout, Pi may reject it as unknown
    // rather than reaching the mode guard — an even earlier refusal. Accept either,
    // but require that the call did NOT execute.
    const sneak = results.find((result: any) => result.toolCallId === "sneak");
    assert.ok(sneak, "the write attempt must be recorded");
    assert.equal(sneak.isError, true, JSON.stringify(sneak.content));
    assert.match(JSON.stringify(sneak.content), /Tool write not found|Supervise mode: .* (blocked|not available)/i);
    assert.doesNotMatch(JSON.stringify(sneak.content), /write ran/, "the write must not have executed");

    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
