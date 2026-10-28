import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import orchestrator from "../../extensions/agent.ts";

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "agent-max-command-"));
  const commands = new Map<string, any>();
  const pi: any = {
    registerTool() {},
    registerCommand(name: string, definition: any) { commands.set(name, definition); },
    on() {},
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools() {},
    appendEntry() {},
    sendMessage() {},
  };
  orchestrator(pi, { client: {} as any, stream: { watch: () => () => {}, onReconcile: () => () => {} } });

  const notices: { text: string; level: string }[] = [];
  const ctx: any = {
    mode: "rpc",
    cwd: dir,
    ui: { notify(text: string, level = "info") { notices.push({ text, level }); } },
  };
  return { dir, commands, notices, ctx, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("/agent max writes the project cap and reports it", async () => {
  const h = await harness();
  try {
    await h.commands.get("agent").handler("max 3 --project", h.ctx);
    const saved = JSON.parse(await readFile(join(h.dir, ".pi", "subagents.json"), "utf8"));
    assert.equal(saved.maxDelegates, 3);

    await h.commands.get("agent").handler("max", h.ctx);
    assert.match(h.notices.at(-1)!.text, /Max delegates: 3/);
  } finally {
    await h.cleanup();
  }
});

test("/agent max refuses zero and non-numbers", async () => {
  const h = await harness();
  try {
    for (const bad of ["0", "21", "abc"]) {
      await h.commands.get("agent").handler(`max ${bad}`, h.ctx);
      assert.equal(h.notices.at(-1)!.level, "error", bad);
    }
  } finally {
    await h.cleanup();
  }
});
