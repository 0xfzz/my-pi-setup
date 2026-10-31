import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import scopeExtension from "../extensions/scope.ts";
import { clearProbeCache } from "../lib/scope/sandbox/probe.ts";

type Hook = (event: any, ctx: any) => unknown;

async function fixture(options: { hasUI?: boolean; mode?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "scope-sandbox-runtime-"));
  const hooks = new Map<string, Hook[]>();
  const commands = new Map<string, any>();
  const appended: Array<{ type: string; data: any }> = [];
  const notices: string[] = [];

  const pi: any = {
    on(name: string, fn: Hook) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
    registerCommand(name: string, definition: any) { commands.set(name, definition); },
    appendEntry(type: string, data: any) { appended.push({ type, data }); },
    getAllTools: () => [{ name: "bash", annotations: {} }],
    events: { emit() {}, on() {} },
  };

  const ctx: any = {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    isIdle: () => true,
    sessionManager: { getCwd: () => dir, getBranch: () => [] },
    ui: {
      notify(text: string) { notices.push(text); },
      setWidget() {},
      custom() {},
      async select(_title: string, labels: string[]) { return labels[0]; },
    },
  };

  scopeExtension(pi);

  const emit = async (name: string, event: any) => {
    const results: unknown[] = [];
    for (const hook of hooks.get(name) ?? []) results.push(await hook(event, ctx));
    return results.filter(result => result !== undefined);
  };

  await emit("session_start", {});

  return {
    dir, pi, ctx, commands, appended, notices,
    emit,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("command /scope sandbox toggles on, off, mode, backend, and runs probe", async () => {
  clearProbeCache();
  const f = await fixture();
  try {
    const handler = f.commands.get("scope")?.handler;
    assert.ok(handler, "scope command handler must be registered");

    await handler("sandbox status", f.ctx);
    assert.match(f.notices.at(-1)!, /Sandbox status: off/);

    await handler("sandbox on", f.ctx);
    assert.match(f.notices.at(-1)!, /sandbox armed in workspace mode/);

    await handler("sandbox status", f.ctx);
    assert.match(f.notices.at(-1)!, /Sandbox status: workspace/);

    await handler("sandbox mode readonly", f.ctx);
    assert.match(f.notices.at(-1)!, /mode set to "readonly"/);

    await handler("sandbox backend bwrap", f.ctx);
    assert.match(f.notices.at(-1)!, /backend set to "bwrap"/);

    await handler("sandbox probe", f.ctx);
    assert.match(f.notices.at(-1)!, /Scope sandbox probe/);

    await handler("sandbox off", f.ctx);
    assert.match(f.notices.at(-1)!, /sandbox disarmed/);
  } finally {
    await f.cleanup();
  }
});

test("tool_call leaves bash unwrapped when sandbox is off", async () => {
  const f = await fixture();
  try {
    const input = { command: "echo hello" };
    const [blocked] = await f.emit("tool_call", { toolName: "bash", input });
    assert.equal(blocked, undefined);
    assert.equal(input.command, "echo hello", "command must remain unwrapped when sandbox is off");
  } finally {
    await f.cleanup();
  }
});

test("tool_call wraps bash when sandbox is armed", async () => {
  clearProbeCache();
  const f = await fixture();
  try {
    const handler = f.commands.get("scope")?.handler;
    await handler("sandbox on", f.ctx);

    const input = { command: "echo sandboxed" };
    const [blocked] = await f.emit("tool_call", { toolName: "bash", input });
    assert.equal(blocked, undefined);

    if (process.platform === "linux") {
      assert.ok(
        input.command.includes("nowrite-guard") || input.command.startsWith("'bwrap'"),
        `expected wrapped with nowrite-guard or bwrap, got: ${input.command}`,
      );
      assert.ok(input.command.includes("echo sandboxed"));
    }
  } finally {
    await f.cleanup();
  }
});

test("tool_result appends trailer on permission refusal when sandbox is active", async () => {
  const f = await fixture();
  try {
    const handler = f.commands.get("scope")?.handler;
    await handler("sandbox on", f.ctx);

    const event = {
      toolName: "bash",
      content: [{ type: "text", text: "touch: cannot touch '/srv/x': Read-only file system" }],
    };

    await f.emit("tool_result", event);
    assert.ok(event.content[0]!.text.includes("[sandbox] blocked a write outside the workspace"));
  } finally {
    await f.cleanup();
  }
});
