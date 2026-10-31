import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import scopeExtension from "../extensions/scope.ts";
import { clearProbeCache, primeProbeCacheForTest, probeBackend } from "../lib/scope/sandbox/probe.ts";

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
  clearProbeCache();
  const f = await fixture();
  try {
    const handler = f.commands.get("scope")?.handler;
    await handler("sandbox on", f.ctx);

    // The trailer may only attach to a call this backend actually wrapped, so
    // run the wrap first: on this machine the auto probe resolves to a
    // working backend (landlock), or the command degrades and the next test
    // owns the assertion.
    const probe = await probeBackend("auto");
    const wrapped: any = { toolName: "bash", input: { command: "echo probe" } };
    await f.emit("tool_call", wrapped);

    const event = {
      toolName: "bash",
      content: [{ type: "text", text: "touch: cannot touch '/srv/x': Read-only file system" }],
    };

    await f.emit("tool_result", event);
    if (probe.ok) {
      assert.ok(event.content[0]!.text.includes("[sandbox] blocked a write outside the workspace"));
    } else {
      assert.ok(!event.content[0]!.text.includes("[sandbox]"), "degraded runs must not misattribute refusals");
    }
  } finally {
    await f.cleanup();
  }
});

test("tool_result never misattributes a refusal when the probe failed", async () => {
  clearProbeCache();
  primeProbeCacheForTest("bwrap", { ok: false, backend: "bwrap", detail: "bwrap probe failed: primed for the test" });
  const f = await fixture();
  try {
    const handler = f.commands.get("scope")?.handler;
    await handler("sandbox backend bwrap", f.ctx);
    await handler("sandbox on", f.ctx);

    await f.emit("tool_call", { toolName: "bash", input: { command: "echo probe" } });

    const event = {
      toolName: "bash",
      content: [{ type: "text", text: "grep: /etc/shadow: Permission denied" }],
    };

    await f.emit("tool_result", event);
    assert.ok(f.notices.some(n => /Running unsandboxed/i.test(n)), "degradation was announced");
    assert.ok(!event.content[0]!.text.includes("[sandbox]"), "a bare run's Permission denied is not a sandbox refusal");
  } finally {
    clearProbeCache();
    await f.cleanup();
  }
});

test("a one-shot refusal answer widens exactly the next bash wrap", async () => {
  // The regression: the trailer said "Retry the command" and the retry was
  // refused identically, because an "allow once" answer never reached the
  // sandbox policy. Nothing here executes bwrap; the assertion is the wrap.
  clearProbeCache();
  primeProbeCacheForTest("bwrap", { ok: true, backend: "bwrap", detail: "primed for the test" });
  const f = await fixture({ mode: "rpc" });
  const outside = await mkdtemp(join(tmpdir(), "scope-outside-"));
  try {
    const handler = f.commands.get("scope")?.handler;
    await handler("sandbox backend bwrap", f.ctx);
    await handler("sandbox on", f.ctx);

    const target = join(outside, "out.txt");
    const first = { toolName: "bash", input: { command: `echo hi > ${target}` } };
    await f.emit("tool_call", first);

    const result = { toolName: "bash", content: [{ type: "text", text: `sh: cannot create ${target}: Permission denied` }] };
    await f.emit("tool_result", result);
    assert.match(result.content[0]!.text, /Answer: allowed once\. Retry the command\./);

    const retry = { toolName: "bash", input: { command: `echo hi > ${target}` } };
    await f.emit("tool_call", retry);

    // Payload only before the answer; payload plus the two --bind arguments after.
    const occurrences = (command: string) => command.split(outside).length - 1;
    assert.equal(occurrences(first.input.command), 1, "the first wrap cannot write there");
    assert.equal(occurrences(retry.input.command), 3, "the retry is bound with the approved folder");
  } finally {
    clearProbeCache();
    await rm(outside, { recursive: true, force: true });
    await f.cleanup();
  }
});
