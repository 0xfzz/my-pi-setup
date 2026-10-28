import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import orchestrator from "../../extensions/agent.ts";

interface Call {
  title: string;
  options: string[];
}

/**
 * The command drives the provider-aware model list from `ctx.modelRegistry`, so
 * the fake registry here is the whole "provider awareness" contract: two
 * providers expose a same-named model (`shared`) to make ambiguity real, and one
 * role model has no credentials.
 */
function registry() {
  return {
    getAll: () => [
      { provider: "zai", id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
      { provider: "deepseek", id: "deepseek-4.1-flash", name: "DeepSeek 4.1 Flash" },
      { provider: "zai", id: "shared", name: "Shared" },
      { provider: "openrouter", id: "shared", name: "Shared" },
    ],
    find: (provider: string, model: string) => ({ provider, id: model }),
    hasConfiguredAuth: (entry: any) => entry?.provider !== "openrouter",
  };
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "orch-model-command-"));
  const commands = new Map<string, any>();
  const pi: any = {
    registerTool() {},
    registerCommand(name: string, definition: any) {
      commands.set(name, definition);
    },
    on() {},
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools() {},
    appendEntry() {},
    sendMessage() {},
  };
  orchestrator(pi, { client: {} as any, stream: { watch: () => () => {}, onReconcile: () => () => {} } });

  const notices: { text: string; level: string }[] = [];
  const calls: Call[] = [];
  const answers: (string | undefined)[] = [];
  const ctx: any = {
    mode: "rpc",
    cwd: dir,
    modelRegistry: registry(),
    ui: {
      notify(text: string, level = "info") {
        notices.push({ text, level });
      },
      select: async (title: string, options: string[]) => {
        calls.push({ title, options: [...options] });
        return answers.shift();
      },
      confirm: async () => false,
      input: async () => "",
    },
  };

  return {
    dir,
    ctx,
    smoke: async (arg: string) => commands.get("agent-model").handler(arg, ctx),
    settingsFile: () => join(dir, ".pi", "subagents.json"),
    readSettings: async () => JSON.parse(await readFile(join(dir, ".pi", "subagents.json"), "utf8")),
    exists: () => existsSync(join(dir, ".pi", "subagents.json")),
    notices,
    calls,
    answers,
    detach: async () => rm(dir, { recursive: true, force: true }),
  };
}

test("the text form saves a provider-qualified pool", async () => {
  const h = await harness();
  try {
    await h.smoke("worker zai/glm-5.3-flash,deepseek/deepseek-4.1-flash --project");
    // Pool order follows the picker's registry order; a roll is uniform, so
    // compare as a set rather than pinning an irrelevant order.
    const saved = (await h.readSettings()).roleModels.worker;
    const keys = (Array.isArray(saved) ? saved : [saved])
      .map((ref: any) => `${ref.provider}/${ref.model}`).sort();
    assert.deepEqual(keys, ["deepseek/deepseek-4.1-flash", "zai/glm-5.3-flash"]);
    assert.match(h.notices.at(-1)!.text, /worker → \[zai\/glm-5\.3-flash, deepseek\/deepseek-4\.1-flash\] \(project\)/);
  } finally {
    await h.detach();
  }
});

test("an ambiguous bare id is refused and nothing is written", async () => {
  const h = await harness();
  try {
    await h.smoke("worker shared --project");
    assert.equal(h.exists(), false, "a refused binding writes nothing");
    assert.equal(h.notices.at(-1)!.level, "error");
    assert.match(h.notices.at(-1)!.text, /ambiguous across providers/);
    assert.match(h.notices.at(-1)!.text, /openrouter\/shared|zai\/shared/);
  } finally {
    await h.detach();
  }
});

test("an unknown role is refused and nothing is written", async () => {
  const h = await harness();
  try {
    await h.smoke("reviewer inherit --project");
    assert.equal(h.exists(), false);
    assert.match(h.notices.at(-1)!.text, /Unknown role "reviewer"/);
  } finally {
    await h.detach();
  }
});

test("the no-arg menu lists the three roles and reopens the binding pre-ticked", async () => {
  const h = await harness();
  try {
    await h.smoke("worker zai/glm-5.3-flash --project");

    // Menu row, then add a second model in the picker, then confirm.
    h.answers.push(
      "worker  zai/glm-5.3-flash",
      "[ ] Model: deepseek/deepseek-4.1-flash",
      "Use selected models (2)",
    );
    await h.smoke("--project");

    const menu = h.calls[0]!;
    assert.equal(menu.title, "Orchestrator child roles");
    assert.deepEqual(menu.options, [
      "devil-advocate  inherit",
      "worker  zai/glm-5.3-flash",
      "qa-review  inherit",
      "Done",
    ]);

    const picker = h.calls[1]!;
    assert.ok(
      picker.options.includes("[x] Model: zai/glm-5.3-flash"),
      "the saved member is pre-ticked in the picker",
    );
    assert.ok(picker.options.some(option => option.endsWith("Model: inherit")), "inherit is offered");
    // Provider awareness is visible in the picker: the same model name under
    // two providers is two distinct rows, not one. (The "(no credentials)"
    // marker rides on the row description, which the TUI renders.)
    assert.ok(picker.options.includes("[ ] Model: zai/shared"));
    assert.ok(picker.options.includes("[ ] Model: openrouter/shared"));

    // Pool order follows the picker's registry order; a roll is uniform, so
    // compare as a set rather than pinning an irrelevant order.
    const saved = (await h.readSettings()).roleModels.worker;
    const keys = (Array.isArray(saved) ? saved : [saved])
      .map((ref: any) => `${ref.provider}/${ref.model}`).sort();
    assert.deepEqual(keys, ["deepseek/deepseek-4.1-flash", "zai/glm-5.3-flash"]);
  } finally {
    await h.detach();
  }
});

test("cancelling the picker keeps the previous binding", async () => {
  const h = await harness();
  try {
    await h.smoke("qa-review inherit --project");
    const before = await h.readSettings();

    h.answers.push("qa-review  inherit", undefined);
    await h.smoke("--project");

    assert.deepEqual(await h.readSettings(), before, "escape writes nothing");
  } finally {
    await h.detach();
  }
});

test("inheriting a single role does not disturb the other roles", async () => {
  const h = await harness();
  try {
    await h.smoke("worker zai/glm-5.3-flash --project");
    await h.smoke("qa-review deepseek/deepseek-4.1-flash --project");
    const settings = await h.readSettings();
    assert.deepEqual(settings.roleModels.worker, { provider: "zai", model: "glm-5.3-flash" });
    assert.deepEqual(settings.roleModels["qa-review"], { provider: "deepseek", model: "deepseek-4.1-flash" });
  } finally {
    await h.detach();
  }
});
