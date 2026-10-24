import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import checkpoints from "../extensions/subagent-checkpoints.ts";
import {
  V1_TOOLS,
  V2_TOOLS,
  getSubagentVersionStatus,
  formatVersionStatus,
  applyVersionToggle,
  parseSubagentsCommand,
  isVersionSwitchCommand,
  saveSubagentVersion,
} from "../lib/version-switch.ts";

test("getSubagentVersionStatus accurately reports active tools", () => {
  const mockPi = {
    getActiveTools: () => ["read", "bash", "subagent", "subagent_resume"],
    getAllTools: () => [
      { name: "read" },
      { name: "bash" },
      { name: "subagent" },
      { name: "subagent_resume" },
      { name: "subagent_interrupt" },
      { name: "subagents_list" },
      { name: "orch_spawn" },
      { name: "orch_resume" },
    ],
  };

  const status = getSubagentVersionStatus(mockPi);
  assert.equal(status.v1Active, true);
  assert.equal(status.v2Active, false);
  assert.deepEqual(status.activeV1Tools, ["subagent", "subagent_resume"]);
  assert.deepEqual(status.activeV2Tools, []);
  assert.equal(status.registeredV1Tools.length, 4);
  assert.equal(status.registeredV2Tools.length, 2);

  const formatted = formatVersionStatus(status);
  assert.match(formatted, /v1: ON/);
  assert.match(formatted, /v2: OFF/);
  assert.match(formatted, /v1 is active/);
});

test("applyVersionToggle turns v1 and v2 on and off", () => {
  let active = ["read", "bash", ...V1_TOOLS, ...V2_TOOLS];
  const all = ["read", "bash", ...V1_TOOLS, ...V2_TOOLS].map((name) => ({ name }));
  const mockPi = {
    getActiveTools: () => [...active],
    setActiveTools: (tools: string[]) => {
      active = [...tools];
    },
    getAllTools: () => all,
  };
  const switchTo = (action: Parameters<typeof applyVersionToggle>[1]) =>
    applyVersionToggle(mockPi, action, disabled);
  let disabled: string[] = [];

  // Turn v1 off
  const res1 = switchTo("v1-off");
  disabled = res1.disabled;
  assert.equal(res1.changed, true);
  assert.equal(res1.status.v1Active, false);
  assert.equal(res1.status.v2Active, true);
  for (const t of V1_TOOLS) {
    assert.equal(active.includes(t), false);
  }

  // Turn v2 off
  const res2 = switchTo("v2-off");
  disabled = res2.disabled;
  assert.equal(res2.changed, true);
  assert.equal(res2.status.v1Active, false);
  assert.equal(res2.status.v2Active, false);
  for (const t of V2_TOOLS) {
    assert.equal(active.includes(t), false);
  }

  // Turn v1 on
  const res3 = switchTo("v1-on");
  disabled = res3.disabled;
  assert.equal(res3.changed, true);
  assert.equal(res3.status.v1Active, true);
  assert.equal(res3.status.v2Active, false);
  for (const t of V1_TOOLS) {
    assert.equal(active.includes(t), true);
  }

  // Turn v2 only (disables v1, enables v2)
  const res4 = switchTo("v2-only");
  disabled = res4.disabled;
  assert.equal(res4.changed, true);
  assert.equal(res4.status.v1Active, false);
  assert.equal(res4.status.v2Active, true);
  for (const t of V1_TOOLS) {
    assert.equal(active.includes(t), false);
  }
  for (const t of V2_TOOLS) {
    assert.equal(active.includes(t), true);
  }

  // Turn v1 only (disables v2, enables v1)
  const res5 = switchTo("v1-only");
  disabled = res5.disabled;
  assert.equal(res5.changed, true);
  assert.equal(res5.status.v1Active, true);
  assert.equal(res5.status.v2Active, false);
  for (const t of V1_TOOLS) {
    assert.equal(active.includes(t), true);
  }
  for (const t of V2_TOOLS) {
    assert.equal(active.includes(t), false);
  }

  // `all on` is the escape hatch: everything back, nothing else touched.
  const res6 = switchTo("all-on");
  assert.equal(res6.changed, true);
  assert.deepEqual(res6.disabled, []);
  for (const t of [...V1_TOOLS, ...V2_TOOLS]) {
    assert.equal(active.includes(t), true, `${t} restored by all-on`);
  }
});

test("applyVersionToggle never touches tools outside the delegate lists", () => {
  // Regression: the old switch wrote the live loadout back verbatim, so anything
  // that happened to be absent when it ran (a restricted-mode snapshot, a
  // late-registering replacement such as the smart-timeout bash override, or an
  // MCP tool that had not connected yet) was silently dropped forever.
  const baseline = ["read", "bash", "edit", "write", "mcp__github__pr", "smart_bash"];
  let active = [...baseline, ...V1_TOOLS];
  const all = [...baseline, ...V1_TOOLS, ...V2_TOOLS].map((name) => ({ name }));
  const mockPi = {
    getActiveTools: () => [...active],
    setActiveTools: (tools: string[]) => {
      active = [...tools];
    },
    getAllTools: () => all,
  };

  const off = applyVersionToggle(mockPi, "v1-off", []);
  assert.equal(off.changed, true);
  assert.deepEqual([...active].sort(), [...baseline].sort(), "non-delegate tools must survive");

  // A restricted mode narrowed the loadout while the switch was on. Re-enabling
  // must still restore exactly the delegate names, not the narrowed snapshot.
  active = ["read", "bash"];
  const on = applyVersionToggle(mockPi, "v1-on", off.disabled);
  assert.equal(on.changed, true);
  for (const t of V1_TOOLS) assert.equal(active.includes(t), true, `${t} restored`);
  assert.deepEqual([...active].sort(), ["bash", "read", ...V1_TOOLS].sort());
});

test("applyVersionToggle is honest when tools are not registered", () => {
  let active = ["read", "bash", ...V1_TOOLS];
  const all = ["read", "bash", ...V1_TOOLS].map((name) => ({ name })); // No V2 tools registered
  const mockPi = {
    getActiveTools: () => [...active],
    setActiveTools: (tools: string[]) => {
      active = [...tools];
    },
    getAllTools: () => all,
  };

  const res = applyVersionToggle(mockPi, "v2-on", []);
  assert.equal(res.changed, false, "nothing to change when no v2 tool is registered");
  assert.match(res.message, /not registered/i);
  assert.match(res.message, /orch_spawn/);
  for (const t of ["read", "bash", ...V1_TOOLS]) {
    assert.equal(active.includes(t), true, `${t} untouched`);
  }
});

test("parseSubagentsCommand parses all subagent control actions", () => {
  assert.equal(parseSubagentsCommand("").action, "browse");
  assert.equal(parseSubagentsCommand("  ").action, "browse");
  assert.equal(parseSubagentsCommand("gc").action, "gc");
  assert.equal(parseSubagentsCommand("gc 24h").action, "gc");
  assert.equal(parseSubagentsCommand("status").action, "status");
  assert.equal(parseSubagentsCommand("off").action, "v1-off");
  assert.equal(parseSubagentsCommand("v1 off").action, "v1-off");
  assert.equal(parseSubagentsCommand("on").action, "v1-on");
  assert.equal(parseSubagentsCommand("v1 on").action, "v1-on");
  assert.equal(parseSubagentsCommand("v2 off").action, "v2-off");
  assert.equal(parseSubagentsCommand("v2 on").action, "v2-on");
  assert.equal(parseSubagentsCommand("v2 only").action, "v2-only");
  assert.equal(parseSubagentsCommand("v1 only").action, "v1-only");
  assert.equal(parseSubagentsCommand("save").action, "save");
  assert.equal(parseSubagentsCommand("help").action, "help");

  assert.equal(isVersionSwitchCommand("off"), true);
  assert.equal(isVersionSwitchCommand("v2 only"), true);
  assert.equal(isVersionSwitchCommand(""), false);
  assert.equal(isVersionSwitchCommand("gc"), false);
});

test("saveSubagentVersion writes atomically and preserves unrelated keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "settings-test-"));
  const settingsFile = join(dir, "settings.json");

  try {
    await writeFile(
      settingsFile,
      JSON.stringify(
        {
          theme: "dark",
          defaultModel: "gemini-3.8-flash",
          packages: ["npm:pi-vcc"],
        },
        null,
        2,
      ),
      "utf8",
    );

    const res = saveSubagentVersion("v2", settingsFile);
    assert.equal(res.success, true);
    assert.match(res.message, /Persisted subagentVersion: "v2"/);

    const saved = JSON.parse(await readFile(settingsFile, "utf8"));
    assert.equal(saved.subagentVersion, "v2");
    assert.equal(saved.theme, "dark");
    assert.equal(saved.defaultModel, "gemini-3.8-flash");
    assert.deepEqual(saved.packages, ["npm:pi-vcc"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/subagents command invokes version switch subcommands cleanly", async () => {
  let active = ["read", "bash", ...V1_TOOLS];
  const all = ["read", "bash", ...V1_TOOLS].map((name) => ({ name }));
  const notifications: any[] = [];
  const commands = new Map<string, any>();
  // The switch decision is persisted on the branch, so the fixture models a
  // branch that grows by appendEntry instead of keeping a module-level array.
  const entryLog: any[] = [];

  const pi: any = {
    on() {},
    registerTool() {},
    registerCommand(name: string, cmd: any) {
      commands.set(name, cmd);
    },
    appendEntry(customType: string, data?: any) {
      entryLog.push({ type: "custom", customType, data, id: `e${entryLog.length}` });
    },
    getActiveTools: () => [...active],
    setActiveTools: (tools: string[]) => {
      active = [...tools];
    },
    getAllTools: () => all,
  };

  const context: any = {
    hasUI: false,
    sessionManager: { getBranch: () => entryLog },
    ui: {
      notify(msg: string, type: string) {
        notifications.push({ msg, type });
      },
    },
  };

  checkpoints(pi);
  const cmd = commands.get("subagents");
  assert.ok(cmd, "subagents command registered");

  // /subagents status
  await cmd.handler("status", context);
  assert.ok(notifications.length > 0);
  assert.match(notifications[notifications.length - 1].msg, /v1: ON/);

  // /subagents off
  await cmd.handler("off", context);
  assert.match(notifications[notifications.length - 1].msg, /v1 subagents turned OFF/);
  for (const t of V1_TOOLS) {
    assert.equal(active.includes(t), false);
  }
  assert.ok(entryLog.some((e) => e.customType === "subagent-switch:v1"), "decision persisted on the branch");

  // /subagents on
  await cmd.handler("on", context);
  assert.match(notifications[notifications.length - 1].msg, /v1 subagents turned ON/);
  for (const t of V1_TOOLS) {
    assert.equal(active.includes(t), true);
  }

  // `/subagents all on` is the documented reset and stays callable.
  await cmd.handler("all on", context);
  assert.match(notifications[notifications.length - 1].msg, /turned ON/);
});
