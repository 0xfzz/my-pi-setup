import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import modes from "../extensions/modes.ts";
import { V1_TOOLS, V2_TOOLS } from "../lib/delegate-switch.ts";

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
        for (const name of ["read", "bash", "edit", "write", "artifact_save", "artifact_edit", "artifact_search", "artifact_recall", "artifact_list", ...V1_TOOLS, ...V2_TOOLS]) {
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
                  // The historical escape hatch, attempted on purpose.
                  call("sneak", "subagent", { agent: "worker", name: "sneaky" }),
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
    // Both authoring and escalation tools must survive the gate. `orch_spawn` without
    // `orch_handoff` is the exact broken combination from the debug session.
    for (const name of ["orch_handoff", "orch_spawn", "orch_escalate", "orch_review", "orch_running", "orch_steer", "orch_route", "read", "artifact_save", "artifact_edit", "artifact_search", "artifact_recall", "artifact_list"]) {
      assert.ok(active.includes(name), `${name} must be active in supervise mode`);
    }
    for (const name of [...V1_TOOLS]) {
      assert.equal(active.includes(name), false, `${name} must be withheld while v2 is in force`);
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

    // ...and the v1 escape hatch was refused. Because v1 is withheld from the
    // loadout, Pi rejects it as unknown rather than reaching the mode guard — an
    // even earlier refusal than the tool_call block. Accept either, but require
    // that the call did NOT execute.
    const sneak = results.find((result: any) => result.toolCallId === "sneak");
    assert.ok(sneak, "the v1 attempt must be recorded");
    assert.equal(sneak.isError, true, JSON.stringify(sneak.content));
    assert.match(JSON.stringify(sneak.content), /Tool subagent not found|Supervise mode: .* is blocked/i);
    assert.doesNotMatch(JSON.stringify(sneak.content), /subagent ran/, "v1 must not have executed");

    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
