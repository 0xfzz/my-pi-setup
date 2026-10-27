import { describe, it } from "node:test";
import assert from "node:assert/strict";

import subagentV2Extension from "../../extensions/orchestrator.ts";

describe("orchestrator extension registration", () => {
  it("registers all orch_* tools and /orch, /steer commands", () => {
    const registeredTools: any[] = [];
    const registeredCommands: any[] = [];
    const eventHandlers = new Map<string, Function[]>();

    const fakePi: any = {
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, options: any) {
        registeredCommands.push({ name, options });
      },
      on(event: string, handler: Function) {
        if (!eventHandlers.has(event)) eventHandlers.set(event, []);
        eventHandlers.get(event)!.push(handler);
      },
      getAllTools() {
        return registeredTools;
      },
    };

    subagentV2Extension(fakePi);

    const toolNames = registeredTools.map((t) => t.name);
    // The orchestrator's two acts come first: author a handoff, record a verdict.
    assert.ok(toolNames.includes("orch_handoff"));
    assert.ok(toolNames.includes("orch_review"));
    assert.ok(toolNames.includes("orch_spawn"));
    assert.ok(toolNames.includes("orch_resume"));
    assert.ok(toolNames.includes("orch_interrupt"));
    assert.ok(toolNames.includes("orch_steer"));
    assert.ok(toolNames.includes("orch_route"));
    assert.ok(toolNames.includes("orch_running"));
    // The uncertainty ladder is a first-class tool, not prompt advice.
    assert.ok(toolNames.includes("orch_escalate"));

    const commandNames = registeredCommands.map((c) => c.name);
    assert.ok(commandNames.includes("orch"));
    assert.ok(commandNames.includes("steer"));
    for (const cmd of registeredCommands) {
      assert.equal(typeof cmd.name, "string");
      assert.ok(cmd.name.length > 0);
      assert.equal(typeof cmd.options.handler, "function");
    }
  });

  it("orch_handoff requires a scope, criteria, and a lane; orch_spawn requires a handoff id", () => {
    const registeredTools: any[] = [];
    const fakePi: any = {
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand() {},
      on() {},
      getAllTools() {
        return registeredTools;
      },
    };

    subagentV2Extension(fakePi);

    const handoff = registeredTools.find((t) => t.name === "orch_handoff");
    assert.ok(handoff, "orch_handoff registered");
    for (const field of ["scope", "goal", "acceptanceCriteria", "laneFiles"]) {
      assert.ok(handoff.parameters.properties[field], `orch_handoff declares ${field}`);
    }
    assert.deepEqual(handoff.parameters.required?.sort(), ["acceptanceCriteria", "goal", "laneFiles", "scope"]);

    const spawn = registeredTools.find((t) => t.name === "orch_spawn");
    assert.ok(spawn, "orch_spawn registered");
    // A child is spawned FROM a handoff. `scope` alone used to be enough, which
    // let a child be launched with no spec at all.
    assert.ok(spawn.parameters.properties.handoffId, "orch_spawn requires a handoff id");
    assert.ok(spawn.parameters.properties.task);
    assert.ok(spawn.parameters.properties.name);
    assert.equal(spawn.parameters.properties.scope, undefined, "orch_spawn no longer takes a bare scope");
  });
});
