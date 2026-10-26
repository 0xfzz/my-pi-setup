import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DELEGATE_SWITCH_TYPE,
  applyDelegationToggle,
  formatDelegationStatus,
  getDelegationStatus,
  isSwitchCommand,
  parseSubagentsCommand,
  reconcileLoadout,
  saveDelegationDefault,
  switchStateFromBranch,
} from "../lib/delegation-switch.ts";
import { DELEGATION_TOOLS, RETIRED_V1_TOOLS } from "../lib/delegation-tools.ts";

const CANONICAL = DELEGATION_TOOLS.map(tool => tool.name);

function fixture(active: string[], registered = CANONICAL) {
  let current = [...active];
  const pi = {
    getActiveTools: () => [...current],
    setActiveTools: (tools: string[]) => { current = [...tools]; },
    getAllTools: () => registered.map(name => ({ name })),
  };
  return { pi, active: () => current };
}

test("status reports the canonical surface, not a version split", () => {
  const { pi } = fixture(["read", ...CANONICAL.slice(0, 3), ...CANONICAL.slice(4)]);
  const status = getDelegationStatus(pi);
  assert.equal(status.enabled, true);
  assert.deepEqual(status.disabledTools, [CANONICAL[3]]);
  assert.deepEqual(status.missingTools, []);
  assert.match(formatDelegationStatus(status), /Delegation: ON/);
  assert.match(formatDelegationStatus(status), /orch_\* only/);
});

test("off disables the whole canonical surface and leaves unrelated tools alone", () => {
  const { pi, active } = fixture(["read", "bash", ...CANONICAL]);
  const result = applyDelegationToggle(pi, false, []);
  assert.equal(result.changed, true);
  assert.deepEqual(active().sort(), ["bash", "read"]);
  assert.deepEqual(result.disabled, [...CANONICAL].sort());
  assert.equal(result.status.enabled, false);
});

test("on restores exactly what off removed, even after a restricted loadout", () => {
  const { pi, active } = fixture(["read", ...CANONICAL]);
  const off = applyDelegationToggle(pi, false, []);
  // A restricted mode narrowed the live set further while the switch was off.
  pi.setActiveTools(["read"]);
  const on = applyDelegationToggle(pi, true, off.disabled);
  assert.equal(on.status.enabled, true);
  for (const name of CANONICAL) assert.ok(active().includes(name), `${name} restored`);
  assert.ok(active().includes("read"));
});

test("the toggle never re-adds a retired v1 name", () => {
  const { pi, active } = fixture(["read", ...RETIRED_V1_TOOLS, ...CANONICAL]);
  applyDelegationToggle(pi, true, []);
  for (const name of RETIRED_V1_TOOLS) assert.equal(active().includes(name), false, `${name} stays removed`);
});

test("reconcileLoadout strips retired names and honours the decision", () => {
  assert.deepEqual(
    reconcileLoadout(["read", "subagent", "orch_spawn", "orch_history"], ["orch_history"]),
    ["read", "orch_spawn"],
  );
});

test("a pre-migration decision is mapped onto the canonical surface", () => {
  const branch = [{
    type: "custom",
    customType: DELEGATE_SWITCH_TYPE,
    data: { disabled: ["subagent", "caller_ping", "orch_history", "bash"] },
  }];
  assert.deepEqual([...switchStateFromBranch(branch).disabled].sort(), ["orch_history", "orch_ping", "orch_spawn"]);
});

test("the command parser has one switch, not a version matrix", () => {
  assert.equal(parseSubagentsCommand("").action, "browse");
  assert.equal(parseSubagentsCommand("gc 24h").action, "gc");
  assert.equal(parseSubagentsCommand("status").action, "status");
  assert.equal(parseSubagentsCommand("on").action, "on");
  assert.equal(parseSubagentsCommand("off").action, "off");
  assert.equal(parseSubagentsCommand("save").action, "save");
  assert.equal(parseSubagentsCommand("help").action, "help");
  assert.equal(parseSubagentsCommand("v2 only").action, "browse", "the v1/v2 matrix is gone");
  assert.equal(isSwitchCommand("v1 off"), false);
  assert.equal(isSwitchCommand("off"), true);
});

test("save persists the delegation default and removes the dead version key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-delegation-switch-"));
  const settings = join(dir, "settings.json");
  try {
    await writeFile(settings, JSON.stringify({ subagentVersion: "v2", theme: "dark" }) + "\n");
    const result = saveDelegationDefault(false, settings);
    assert.equal(result.success, true);
    const saved = JSON.parse(await readFile(settings, "utf8"));
    assert.equal(saved.delegation, "off");
    assert.equal(saved.theme, "dark", "unrelated keys survive");
    assert.equal("subagentVersion" in saved, false, "the v1/v2 default is removed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
