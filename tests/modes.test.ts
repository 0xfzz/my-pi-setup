import test from "node:test";
import assert from "node:assert/strict";
import { MODES, ModeRegistry, routeSubmissions } from "../lib/modes.ts";
import modesExtension from "../extensions/modes.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

test("mode registry cycles and supports additional modes", () => {
  const registry = new ModeRegistry();
  assert.equal(registry.current.id, "normal");
  registry.cycle();
  assert.equal(registry.current.id, "plan");
  registry.cycle(); // supervise is not cycleable; orchestrator is
  assert.equal(registry.current.id, "orchestrator");
  registry.cycle();
  assert.equal(registry.current.id, "normal");
  assert.equal(registry.select("missing"), false);
  const extended = new ModeRegistry([...registry.modes, { id: "third", label: "Third", hint: "Custom", route: t => t }]);
  extended.select("plan");
  extended.cycle(); // supervise is not cycleable
  assert.equal(extended.current.id, "orchestrator");
  extended.cycle();
  assert.equal(extended.current.id, "third");
  assert.throws(() => new ModeRegistry([]));
  assert.throws(() => new ModeRegistry([registry.current, registry.current]));
});

test("built-in modes have distinct one-column icons and compact descriptions", () => {
  assert.equal(new Set(MODES.map(mode => mode.icon)).size, MODES.length);
  for (const mode of MODES) {
    assert.equal(visibleWidth(mode.icon!), 1);
    assert.ok(visibleWidth(`${mode.icon} ${mode.label}`) <= 18);
    assert.ok(mode.summary && visibleWidth(mode.summary) <= 18);
    assert.ok(mode.tone);
  }
});

test("every mode routes submissions through the live mode", () => {
  const registry = new ModeRegistry();
  assert.equal(registry.current.route("hello"), "hello");
  registry.select("plan");
  for (const command of ["pwd", "echo 'a b' | wc -c", "/usr/bin/printf ok", "! false", "echo one\necho two"]) {
    assert.equal(registry.current.route(command), command);
  }
});

test("submission wrapping follows live mode and host callback replacement", () => {
  const registry = new ModeRegistry();
  const editor: { onSubmit?: (text: string) => void } = {};
  routeSubmissions(editor, text => registry.current.route(text));
  assert.equal(editor.onSubmit, undefined);
  const submissions: string[] = [];
  editor.onSubmit = text => { submissions.push(text); };
  editor.onSubmit("hello");
  registry.select("plan");
  editor.onSubmit("pwd");
  editor.onSubmit = text => { submissions.push(`new:${text}`); };
  editor.onSubmit("ls");
  assert.deepEqual(submissions, ["hello", "pwd", "new:ls"]);
});

test("actual custom editor consumes Shift+Tab, retains draft, renders narrow UI, and routes submission", async () => {
  const events = new Map<string, Function>();
  let command: any;
  modesExtension({ on: (event: string, handler: Function) => events.set(event, handler),
    registerCommand: (name: string, definition: any) => { if (name === "mode") command = definition; },
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, appendEntry() {} } as any);
  let editorFactory: any;
  let widgetFactory: any;
  const ctx: any = { mode: "tui", isIdle: () => true, sessionManager: { getBranch: () => [] }, ui: {
    setWidget: (_key: string, factory: any) => { widgetFactory = factory; },
    setEditorComponent: (factory: any) => { editorFactory = factory; },
    notify() {},
  } };
  events.get("session_start")!({}, ctx);
  const color = (text: string) => text;
  const theme: any = { borderColor: color, selectList: { selectedPrefix: color, selectedText: color,
    description: color, scrollInfo: color, noMatch: color } };
  let renders = 0;
  const editor = editorFactory({ requestRender() { renders++; }, terminal: { rows: 30, columns: 80 } }, theme, { matches: () => false });
  const submissions: string[] = [];
  editor.onSubmit = (text: string) => submissions.push(text);
  editor.setText("echo draft");
  editor.handleInput("\x1b[Z");
  assert.equal(editor.getText(), "echo draft");
  editor.onSubmit(editor.getText());
  assert.deepEqual(submissions, ["echo draft"]);
  const widget = widgetFactory({}, { fg: (_token: string, text: string) => text, bold: color });
  assert.match(widget.render(100)[0], /\[ 󰏫 Plan \]/u);
  assert.match(widget.render(100)[0], /󰚥 Normal/);
  for (const width of [1, 8, 25, 80]) {
    for (const line of widget.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  await command.handler("normal", ctx);
  editor.onSubmit("AI again");
  assert.equal(submissions.at(-1), "AI again");
  assert.ok(renders >= 2);
  events.get("session_shutdown")!({}, ctx);
});

// Regression coverage for the removed Bash mode lives in the /mode command and
// Shift+Tab runtime tests; unknown mode IDs must be refused without state change.
test("unknown mode IDs are refused by the /mode command", async () => {
  const events = new Map<string, Function>();
  let command: any;
  modesExtension({ on: (event: string, handler: Function) => events.set(event, handler),
    registerCommand: (name: string, definition: any) => { if (name === "mode") command = definition; },
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, appendEntry() {} } as any);
  const notices: string[] = [];
  const ctx: any = { mode: "tui", isIdle: () => true, sessionManager: { getBranch: () => [] }, ui: {
    setWidget() {}, setEditorComponent() {}, notify(text: string) { notices.push(text); },
  } };
  events.get("session_start")!({}, ctx);
  await command.handler("bash", ctx);
  assert.match(notices.at(-1)!, /Unknown mode: bash/);
  events.get("session_shutdown")!({}, ctx);
});

// The cycle used to move the registry cursor BEFORE the policy was written, and
// select() then compared against that cursor, so it believed the switch was
// already applied: Plan → Orchestrator drew the Orchestrator tab while the tools
// stayed in Plan's loadout and no supervisor entry existed, and the following
// Shift+Tab ping-ponged back to Plan instead of reaching Normal.
test("ModeRegistry.next() previews the target without moving the cursor", () => {
  const registry = new ModeRegistry();
  registry.select("plan");
  assert.equal(registry.next().id, "orchestrator");
  assert.equal(registry.current.id, "plan", "next() must not commit the switch");
  registry.select("orchestrator");
  assert.equal(registry.next().id, "normal");
  assert.equal(registry.current.id, "orchestrator");
});

function modeHarness(initialBranch: any[] = []) {
  const events = new Map<string, Function>();
  const commands = new Map<string, any>();
  const branch = initialBranch;
  const activeTools = new Set(["read", "edit", "write", "bash", "artifact_save", "orch_spawn", "orch_handoff", "orch_review"]);
  const fakePi: any = {
    getAllTools: () => ["read", "edit", "write", "bash", "artifact_save", "orch_spawn", "orch_handoff", "orch_review"]
      .map(name => ({ name })),
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools: string[]) => { activeTools.clear(); for (const tool of tools) activeTools.add(tool); },
    on: (event: string, handler: Function) => events.set(event, handler),
    registerCommand: (name: string, definition: any) => commands.set(name, definition),
    appendEntry: (customType: string, data: any) => branch.push({ type: "custom", customType, data }),
  };
  modesExtension(fakePi);
  const notices: string[] = [];
  let widgetFactory: any;
  const ctx: any = {
    mode: "tui", isIdle: () => true,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify(text: string) { notices.push(text); },
      setWidget(_key: string, factory: any) { widgetFactory = factory; },
      setEditorComponent() {},
    },
  };
  events.get("session_start")!({}, ctx);
  const activeTab = () => {
    const widget = widgetFactory({}, { fg: (_token: string, text: string) => text, bold: (text: string) => text });
    return widget.render(200)[0];
  };
  return { events, commands, branch, activeTools, ctx, notices, activeTab, fakePi };
}

test("Shift+Tab from Plan reaches Orchestrator with its policy and then Normal with its tools back", async () => {
  const h = modeHarness();
  await h.commands.get("plan").handler("on", h.ctx);
  assert.ok(!h.activeTools.has("edit"), "Plan removes edit");
  assert.equal(h.branch.at(-1).data.enabled, true);

  // Plan → Orchestrator: the supervisor policy must actually be persisted.
  await h.commands.get("mode").handler("", h.ctx);
  assert.equal(h.branch.at(-1).customType, "input-supervise-mode:v1", "Orchestrator persists supervisor policy");
  assert.equal(h.branch.at(-1).data.enabled, true);
  assert.equal(h.branch.at(-1).data.modeId, "orchestrator", "the tab the user picked is recorded");
  assert.ok(!h.activeTools.has("edit"), "Orchestrator keeps edit disabled");
  assert.ok(!h.activeTools.has("write"), "Orchestrator keeps write disabled");
  assert.ok(h.activeTools.has("orch_spawn"), "delegation stays available");
  assert.match(h.activeTab(), /\[ 󰀅 Orchestrator \]/u, "the Orchestrator tab is the active one");

  // Orchestrator → Normal: the saved loadout comes back.
  await h.commands.get("mode").handler("", h.ctx);
  assert.equal(h.branch.at(-1).data.enabled, false, "leaving Orchestrator is recorded");
  assert.ok(h.activeTools.has("edit"), "Normal restores edit");
  assert.ok(h.activeTools.has("write"), "Normal restores write");
  assert.match(h.activeTab(), /\[ 󰚥 Normal \]/u, "the Normal tab is the active one");

  // ...and the cycle continues: Normal → Plan.
  await h.commands.get("mode").handler("", h.ctx);
  assert.match(h.activeTab(), /\[ 󰏫 Plan \]/u);
  h.events.get("session_shutdown")!({}, h.ctx);
});

test("a refused mode switch leaves both the cursor and the transcript unchanged", async () => {
  const h = modeHarness();
  await h.commands.get("plan").handler("on", h.ctx);
  const entriesBefore = h.branch.length;
  let idle = false;
  h.ctx.isIdle = () => idle;
  await h.commands.get("mode").handler("", h.ctx);
  assert.equal(h.branch.length, entriesBefore, "no mode entry is written while a turn is running");
  assert.ok(!h.activeTools.has("edit"), "Plan restrictions stay in force");
  assert.match(h.notices.at(-1)!, /Stop the current turn/);
  assert.match(h.activeTab(), /\[ 󰏫 Plan \]/, "the tab does not advance either");
  idle = true;
  await h.commands.get("mode").handler("", h.ctx);
  assert.match(h.activeTab(), /\[ 󰀅 Orchestrator \]/u, "the refused step is not skipped, only deferred");
  h.events.get("session_shutdown")!({}, h.ctx);
});

test("a reload restores the supervisor tab the user actually chose", async () => {
  const branch: any[] = [
    { type: "custom", customType: "input-supervise-mode:v1", data: { enabled: true, previousTools: ["read", "edit", "write"], modeId: "orchestrator" } },
  ];
  const h = modeHarness(branch);
  assert.match(h.activeTab(), /\[ 󰀅 Orchestrator \]/u);
  assert.ok(!h.activeTools.has("edit"), "restored supervisor policy still blocks edits");
  h.events.get("session_shutdown")!({}, h.ctx);

  // Legacy entries predate modeId; they keep their original Supervise label.
  const legacy = modeHarness([
    { type: "custom", customType: "input-supervise-mode:v1", data: { enabled: true, previousTools: ["read", "edit"] } },
  ]);
  assert.match(legacy.activeTab(), /\[ 󰒋 Supervise \]/u);
  legacy.events.get("session_shutdown")!({}, legacy.ctx);
});
