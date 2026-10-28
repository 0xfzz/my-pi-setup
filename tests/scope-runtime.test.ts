import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import scopeExtension from "../extensions/scope.ts";
import { SECTION_EVENT } from "../lib/sidebar-channel.ts";

type Hook = (event: any, ctx: any) => unknown;

const theme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_token: string, text: string) => text,
};

async function fixture(options: { hasUI?: boolean; mode?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "scope-runtime-"));
  const hooks = new Map<string, Hook[]>();
  const commands = new Map<string, any>();
  const appended: Array<{ type: string; data: any }> = [];
  const notices: string[] = [];
  const sections: any[] = [];
  const widgets = new Map<string, any>();
  let dialog: { component: any } | undefined;
  let pendingResolve: ((answer: any) => void) | undefined;

  const pi: any = {
    on(name: string, fn: Hook) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
    registerCommand(name: string, definition: any) { commands.set(name, definition); },
    appendEntry(type: string, data: any) { appended.push({ type, data }); },
    getAllTools: () => [{ name: "read", annotations: {} }],
    events: {
      emit(name: string, data: any) {
        if (name !== SECTION_EVENT) return;
        // No sidebar in these fixtures: the extension must fall back to a widget.
        sections.push(data);
      },
      on() {},
    },
  };

  const ctx: any = {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    isIdle: () => true,
    sessionManager: { getCwd: () => dir, getBranch: () => [] },
    ui: {
      notify(text: string) { notices.push(text); },
      setWidget(key: string, content: any) { widgets.set(key, content); },
      custom(factory: any) {
        return new Promise((resolve: (value: any) => void) => {
          pendingResolve = resolve;
          dialog = { component: factory({ terminal: { rows: 30, columns: 100 }, requestRender() {} }, theme, {}, resolve) };
        });
      },
      async select(_title: string, labels: string[]) { return labels[0]; },
    },
  };

  scopeExtension(pi);
  await emit("session_start", {});
  return {
    dir, pi, ctx, commands, appended, notices, sections, widgets,
    get dialog() { return dialog; },
    async emit(name: string, event: any) {
      const results: unknown[] = [];
      for (const hook of hooks.get(name) ?? []) results.push(await hook(event, ctx));
      return results.filter(result => result !== undefined);
    },
    /** A test that leaves a question open must not leave a pending promise. */
    cleanup: async () => {
      pendingResolve?.({ kind: "deny" });
      pendingResolve = undefined;
      await rm(dir, { recursive: true, force: true });
    },
  };

  async function emit(name: string, event: any) {
    const results: unknown[] = [];
    for (const hook of hooks.get(name) ?? []) results.push(await hook(event, ctx));
    return results.filter(result => result !== undefined);
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("a read inside the workspace passes without a dialog", async () => {
  const f = await fixture();
  try {
    const result = await f.emit("tool_call", { toolName: "read", input: { path: "AGENTS.md" } });
    assert.deepEqual(result, []);
    assert.equal(f.dialog, undefined);
  } finally {
    await f.cleanup();
  }
});

test("an outside read opens one dialog; allow-once runs it, deny blocks it", async () => {
  const allowed = await fixture();
  try {
    const pending = allowed.emit("tool_call", { toolName: "read", input: { path: "../elsewhere/a.txt" } });
    await tick();
    assert.ok(allowed.dialog, "the dialog must open for an outside path");
    allowed.dialog!.component.handleInput("1");
    assert.deepEqual(await pending, []);
    assert.equal(allowed.appended.length, 0, "allow once must not write a grant");
  } finally {
    await allowed.cleanup();
  }

  const denied = await fixture();
  try {
    const pending = denied.emit("tool_call", { toolName: "read", input: { path: "../elsewhere/a.txt" } });
    await tick();
    denied.dialog!.component.handleInput("3");
    const [result] = await pending as Array<{ block: boolean; reason: string }>;
    assert.equal(result?.block, true);
    assert.match(result!.reason, /denied access to/);
    assert.match(result!.reason, /\/scope allow/, "the block tells the model how to ask for access");
  } finally {
    await denied.cleanup();
  }
});

test("allow this folder writes a branch snapshot and stops asking", async () => {
  const f = await fixture();
  try {
    const pending = f.emit("tool_call", { toolName: "read", input: { path: "../elsewhere/a.txt" } });
    await tick();
    f.dialog!.component.handleInput("2");
    assert.deepEqual(await pending, []);
    assert.equal(f.appended.length, 1);
    assert.equal(f.appended[0]?.type, "agent-scope:v1");
    assert.equal(f.appended[0]?.data.roots.some((root: any) => root.path.endsWith("/elsewhere")), true);

    const again = await f.emit("tool_call", { toolName: "read", input: { path: "../elsewhere/b.txt" } });
    assert.deepEqual(again, [], "the folder grant covers its siblings");
  } finally {
    await f.cleanup();
  }
});

test("a session with no UI blocks with an actionable message instead of pretending", async () => {
  const f = await fixture({ hasUI: false, mode: "print" });
  try {
    const [result] = await f.emit("tool_call", { toolName: "read", input: { path: "/etc/hosts" } }) as Array<{ block: boolean; reason: string }>;
    assert.equal(result?.block, true);
    assert.match(result!.reason, /no dialog is available/);
    assert.match(result!.reason, /\/scope allow/);
  } finally {
    await f.cleanup();
  }
});

test("/scope status and /scope deny steer the same state the gate uses", async () => {
  const f = await fixture();
  try {
    await f.commands.get("scope").handler("deny ../elsewhere", f.ctx);
    assert.equal(f.appended.length, 1, "a session deny is persisted");
    const [result] = await f.emit("tool_call", { toolName: "read", input: { path: "../elsewhere/a.txt" } }) as Array<{ block: boolean; reason: string }>;
    assert.equal(result?.block, true);
    assert.match(result!.reason, /denied/i);

    await f.commands.get("scope").handler("status", f.ctx);
    assert.match(f.notices.at(-1)!, /Scope/);
    assert.match(f.notices.at(-1)!, /defaults: external=ask/);
  } finally {
    await f.cleanup();
  }
});

test("yolo arms with a warning, approves, and still respects a deny rule", async () => {
  const f = await fixture();
  try {
    await f.commands.get("scope").handler("yolo", f.ctx);
    assert.match(f.notices.at(-1)!, /yolo ro armed/);
    assert.match(f.notices.at(-1)!, /\/scope yolo off/);
    assert.deepEqual(await f.emit("tool_call", { toolName: "read", input: { path: "../elsewhere/a.txt" } }), []);

    await f.commands.get("scope").handler("deny ../elsewhere", f.ctx);
    const [blocked] = await f.emit("tool_call", { toolName: "read", input: { path: "../elsewhere/b.txt" } }) as Array<{ block: boolean }>;
    assert.equal(blocked?.block, true, "yolo must never override an explicit deny");

    await f.commands.get("scope").handler("yolo off", f.ctx);
    assert.match(f.notices.at(-1)!, /disarmed/);
  } finally {
    await f.cleanup();
  }
});

test("the sidebar offer carries the workspace row and falls back to a widget", async () => {
  const f = await fixture();
  try {
    const offer = f.sections.at(-1);
    assert.equal(offer?.section.id, "scope");
    assert.match(offer?.section.title, /Scope/);
    assert.match(offer?.section.rows[0], /workspace/);
    assert.equal(f.widgets.has("scope"), true, "without a sidebar the widget is installed instead");
  } finally {
    await f.cleanup();
  }
});
