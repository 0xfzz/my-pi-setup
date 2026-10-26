import test from "node:test";
import assert from "node:assert/strict";

import { DELEGATE_SWITCH_TYPE, reconcileLoadout, switchStateFromBranch } from "../lib/delegation-switch.ts";
import { RETIRED_V1_TOOLS, stripRetiredTools } from "../lib/delegation-tools.ts";

/**
 * Mirrors `restoreTools` in extensions/modes.ts: the persisted snapshot is
 * stripped of retired names, then filtered by the session's switch decision.
 *
 * The strip is deliberately NOT inside `reconcileLoadout`: the v1 toggle still
 * exists in this step and must be able to re-enable its own tools. It is deleted
 * in the next step, at which point the strip can move into the loadout helper.
 */
const restoreLoadout = (names: string[], disabled: string[] = []): string[] =>
  reconcileLoadout(stripRetiredTools(names), disabled);

test("the restore path never resurrects a retired v1 tool", () => {
  assert.deepEqual(
    restoreLoadout(["read", "bash", "subagent", "subagent_done", "caller_ping", "orch_spawn"]),
    ["read", "bash", "orch_spawn"],
  );
  // Even an explicit `disabled` list cannot make a retired name survive.
  assert.deepEqual(
    restoreLoadout(["read", "subagent", "orch_done"], ["orch_done"]),
    ["read"],
  );
});

test("every retired name is dropped from a restored loadout, at any position", () => {
  const retired = [...RETIRED_V1_TOOLS];
  assert.deepEqual(restoreLoadout(retired), []);
  assert.deepEqual(
    restoreLoadout(["read", ...retired, "orch_history", "read"]),
    ["read", "orch_history"],
  );
});

test("a switch decision keeps only names on the delegation surface", () => {
  const branch = [{
    type: "custom",
    customType: DELEGATE_SWITCH_TYPE,
    data: { disabled: ["bash", "orch_history", "not_a_tool"] },
  }];
  const { disabled } = switchStateFromBranch(branch);
  assert.deepEqual([...disabled], ["orch_history"]);
  assert.equal(disabled.has("bash"), false, "a non-delegation name never enters the decision");
});

test("a later switch entry still wins", () => {
  const branch = [
    { type: "custom", customType: DELEGATE_SWITCH_TYPE, data: { disabled: ["orch_history"] } },
    { type: "custom", customType: DELEGATE_SWITCH_TYPE, data: { disabled: [] } },
  ];
  assert.deepEqual([...switchStateFromBranch(branch).disabled], [], "the newest decision wins");
});
