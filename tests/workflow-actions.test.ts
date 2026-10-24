import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerWorkflowActions, WORKFLOW_PREFIX } from "../lib/workflow-actions.ts";

function fixture(mode = "tui", hasUI = true) {
  const shortcuts = new Map<string, any>();
  const commands = new Map<string, any>();
  const events: string[] = [];
  const notices: string[] = [];
  let component: any;
  let closed = true;
  let calls = 0;
  const ctx: any = { mode, hasUI, ui: {
    notify: (text: string) => notices.push(text),
    custom: (factory: any, options: any) => {
      calls++;
      closed = false;
      assert.equal(options.overlay, true);
      return new Promise(resolve => {
        component = factory({}, { fg: (_: string, text: string) => text, bold: (text: string) => text }, {}, (value: any) => {
          closed = true;
          resolve(value);
        });
      });
    },
  } };
  registerWorkflowActions({
    registerShortcut: (key: string, config: any) => shortcuts.set(key, config),
    registerCommand: (name: string, config: any) => commands.set(name, config),
    events: { emit: (event: string) => {
      assert.equal(closed, true, "Prefix must close before destination opens");
      events.push(event);
    } },
  } as any);
  return { ctx, shortcuts, commands, events, notices, component: () => component, calls: () => calls };
}

for (const [key, event] of [
  ["t", "workflow-todo:open-dialog"],
  ["s", "subagent-checkpoints:open-dialog"],
  ["e", "artifacts:open-dialog"],
  ["T", "workflow-todo:open-dialog"],
  ["S", "subagent-checkpoints:open-dialog"],
  ["E", "artifacts:open-dialog"],
]) {
  test(`prefix action ${key} opens details immediately without Enter`, async () => {
    const f = fixture();
    const run = f.shortcuts.get(WORKFLOW_PREFIX).handler(f.ctx);
    const rendered44 = f.component().render(44);
    assert.match(rendered44.join("\n"), /Todo details/);
    assert.match(rendered44.join("\n"), /Workflow · Alt\+W/);
    assert.ok(rendered44.some((line: string) => line.includes("╭") && line.includes("╮")));
    assert.ok(rendered44.every((line: string) => visibleWidth(line) <= 44));
    assert.ok(f.component().render(8).every((line: string) => visibleWidth(line) <= 8));
    f.component().handleInput(key);
    await run;
    assert.deepEqual(f.events, [event]);
  });
}

test("Esc and Ctrl+C cancel without dispatch; repeated prefix does not stack screens", async () => {
  const f = fixture();
  const handler = f.shortcuts.get(WORKFLOW_PREFIX).handler;
  const first = handler(f.ctx);
  await handler(f.ctx);
  assert.equal(f.calls(), 1);
  f.component().handleInput("z");
  assert.deepEqual(f.events, []);
  f.component().handleInput("\x1b");
  await first;
  const second = handler(f.ctx);
  f.component().handleInput("\x03");
  await second;
  assert.deepEqual(f.events, []);
  assert.equal(f.calls(), 2);
});

test("/workflow offers the same prefix menu and leaves no input listener behind", async () => {
  const f = fixture();
  const run = f.commands.get("workflow").handler("", f.ctx);
  f.component().handleInput("t");
  await run;
  assert.deepEqual(f.events, ["workflow-todo:open-dialog"]);
});

test("UI failures release the guard so the next invocation works", async () => {
  const f = fixture();
  const custom = f.ctx.ui.custom;
  f.ctx.ui.custom = async () => { throw new Error("UI unavailable"); };
  const handler = f.shortcuts.get(WORKFLOW_PREFIX).handler;
  await assert.rejects(handler(f.ctx), /UI unavailable/);
  f.ctx.ui.custom = custom;
  const run = handler(f.ctx);
  f.component().handleInput("s");
  await run;
  assert.deepEqual(f.events, ["subagent-checkpoints:open-dialog"]);
});

test("headless and RPC modes never create terminal overlays", async () => {
  const headless = fixture("print", false);
  await headless.shortcuts.get(WORKFLOW_PREFIX).handler(headless.ctx);
  assert.equal(headless.calls(), 0);
  const rpc = fixture("rpc");
  await rpc.commands.get("workflow").handler("", rpc.ctx);
  assert.equal(rpc.calls(), 0);
  assert.match(rpc.notices[0]!, /workflow-todos/);
  assert.match(rpc.notices[0]!, /artifacts/);
});
