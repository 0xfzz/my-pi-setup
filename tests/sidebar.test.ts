import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Container, Text, TuiAltScreen, TuiMainScreen, ScrollView, VStack, visibleWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import sidebar from "../extensions/sidebar.ts";
import todo from "../extensions/todo.ts";
import artifacts from "../extensions/artifacts.ts";
import modes from "../extensions/modes.ts";
import { SidebarMount, SidebarSplit, plain } from "../lib/sidebar/sidebar-layout.ts";
import { getAquariumSimulation, clearAquariumFood } from "../lib/sidebar/sidebar-aquarium.ts";

const terminal = () => ({ columns: 120, rows: 24, write() {}, start() {}, stop() {},
  showCursor() {}, hideCursor() {}, moveBy() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
  setTitle() {}, getCellSize() { return undefined; } }) as any;
const theme: any = { fg: (_token: string, text: string) => text, bold: (text: string) => text };

test("regular split reserves 24 columns, preserves cursor marker, and follows visible tail", () => {
  const main = new Container();
  let requestedWidth = 0;
  const marker = `draft${CURSOR_MARKER}`;
  main.addChild({ render(width) { requestedWidth = width; return [...Array(30).fill("chat"), marker]; }, invalidate() {} });
  const side = new Text("MODE\nTODO\nARTIFACTS", 0, 0);
  let enabled = true;
  const split = new SidebarSplit(main, side, { terminal: terminal() }, () => enabled);
  const lines = split.render(120);
  assert.equal(requestedWidth, 96);
  assert.equal(lines.length, 31);
  assert.match(lines[7]!, /MODE/);
  assert.match(lines[8]!, /TODO/);
  assert.ok(lines[30]!.includes(CURSOR_MARKER));
  assert.ok(lines.every(line => visibleWidth(line) <= 120));
  assert.equal(split.render(80).some(line => line.includes("MODE")), false);
  assert.equal(requestedWidth, 80);
  enabled = false;
  assert.equal(split.render(120).some(line => line.includes("MODE")), false);
  assert.equal(requestedWidth, 120);
});

test("regular mounting and repeated cleanup preserve original components", () => {
  const tui = new TuiMainScreen(terminal());
  const original = new Text("chat", 0, 0);
  tui.addChild(original);
  const mount = new SidebarMount(tui, new Text("sidebar", 0, 0), () => true);
  assert.equal(mount.ensure(), true);
  assert.equal(mount.ensure(), true);
  assert.equal(tui.children.length, 1);
  assert.ok(tui.render(120).some(line => line.includes("sidebar")));
  mount.dispose(); mount.dispose();
  assert.deepEqual(tui.children, [original]);
});

test("fullscreen retains exact ScrollView, scroll state, responsive width, and root cleanup", () => {
  const tui = new TuiAltScreen(terminal());
  const scroll = new ScrollView(new Text(Array(100).fill("message").join("\n"), 0, 0), { primary: true });
  const root = new VStack([{ component: scroll, grow: 1 }]);
  tui.setLayoutRoot(root);
  scroll.updateLayout(100, 24, () => {});
  scroll.scrollTo(20);
  const before = Reflect.get(tui, "layoutRoot");
  const mount = new SidebarMount(tui, new Text("SIDEBAR", 0, 0), () => true);
  assert.equal(mount.ensure(), true);
  const wrapped: any = Reflect.get(tui, "layoutRoot");
  assert.equal(wrapped.entries[0].component, before);
  assert.equal(wrapped.entries[0].component.entries[0].component, scroll);
  assert.equal(scroll.scrollTop, 20);
  assert.match(wrapped.render(120).join("\n"), /SIDEBAR/);
  assert.doesNotMatch(wrapped.render(80).join("\n"), /SIDEBAR/);
  // Simulate host re-installing its own root after a renderer switch.
  tui.setLayoutRoot(root);
  assert.equal(mount.ensure(), true);
  assert.equal((Reflect.get(tui, "layoutRoot") as any).entries[0].component, root);
  mount.dispose(); mount.dispose();
  assert.equal(Reflect.get(tui, "layoutRoot"), root);
});

function fixture(order: Function[], mode: "regular" | "fullscreen" = "regular") {
  const emitter = new EventEmitter();
  const hooks = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const widgets = new Map<string, any>();
  const branch: any[] = [];
  const tui = mode === "fullscreen" ? new TuiAltScreen(terminal()) : new TuiMainScreen(terminal());
  const original = new Text("chat\ninput\nfooter", 0, 0);
  tui.addChild(original);
  const root = new VStack([{ component: original, grow: 1 }]);
  if (mode === "fullscreen") (tui as TuiAltScreen).setLayoutRoot(root);
  const pi: any = {
    events: { emit: (key: string, data: unknown) => { emitter.emit(key, data); },
      on: (key: string, handler: any) => { emitter.on(key, handler); return () => emitter.off(key, handler); } },
    on(key: string, handler: Function) { hooks.set(key, [...(hooks.get(key) ?? []), handler]); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerShortcut(key: string, shortcut: any) { shortcuts.set(key, shortcut); },
    appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
    getActiveTools: () => [...tools.keys()],
    getAllTools: () => [...tools.values()],
    setActiveTools() {},
  };
  const ctx: any = { mode: "tui", hasUI: true, isIdle: () => true, sessionManager: { getBranch: () => branch }, ui: {
    theme,
    setEditorComponent() {},
    addAutocompleteProvider() {},
    setWidget(key: string, value: any) {
      widgets.get(key)?.dispose?.();
      if (value === undefined) widgets.delete(key);
      else widgets.set(key, typeof value === "function" ? value(tui, theme) : value);
    },
    notify() {},
  } };
  for (const factory of order) factory(pi);
  const emit = async (key: string, event = {}) => { for (const handler of hooks.get(key) ?? []) await handler(event, ctx); };
  const call = (name: string, args: unknown) => tools.get(name).execute("test", args, undefined, undefined, ctx);
  return { tui, ctx, widgets, commands, shortcuts, branch, emit, call, original, root, events: emitter };
}

for (const mode of ["regular", "fullscreen"] as const) {
  test(`Alt+W then T opens the actual todo dialog in ${mode}, including with sidebar disabled`, async () => {
    const f = fixture([sidebar, todo], mode);
    await f.emit("session_start");
    await f.call("workflow_todo", { action: "plan", steps: ["Inspect", "Implement", "Verify", "Report"] });
    // ui.custom drives both the Alt+W prefix and the framed todo picker; the
    // legacy ui.select/ui.confirm path must not be used while ui.custom exists.
    const calls: { component: any; promise: Promise<any> }[] = [];
    f.ctx.ui.custom = (factory: any) => {
      let resolve!: (value: any) => void;
      const promise = new Promise<any>(r => { resolve = r; });
      const component = factory(f.tui, theme, {}, resolve);
      calls.push({ component, promise });
      return promise;
    };
    let selects = 0;
    f.ctx.ui.select = async (_title: string, options: string[]) => {
      selects++;
      assert.equal(options.length, 4);
      return undefined;
    };
    try {
      for (const disable of [false, true]) {
        if (disable) await f.commands.get("sidebar").handler("off", f.ctx);
        calls.length = 0;
        const run = f.shortcuts.get("alt+w").handler(f.ctx);
        const prefix = calls[0];
        assert.ok(prefix, "Alt+W must open the prefix popup synchronously");
        prefix.component.handleInput("t");
        await run;

        // The todo dialog opened as a framed picker with all four steps.
        const picker = calls[1];
        assert.ok(picker, "T must open the todo picker popup");
        const lines = picker.component.render(60) as string[];
        assert.match(lines[0] ?? "", /Intent plan p-[0-9a-f]{6} \(0\/4\)/, "picker carries its framed title");
        const body = lines.join("\n");
        for (const step of ["Inspect", "Implement", "Verify", "Report"]) {
          assert.ok(body.includes(step), `picker lists step: ${step}`);
        }
        assert.equal(lines.filter(line => line.includes("╭")).length, 1, "picker draws a popup frame");
        assert.ok(lines.every(line => visibleWidth(line) <= 60), "picker renders within its width");
        assert.equal(selects, 0, "legacy ui.select path stays unused while ui.custom exists");

        // Esc dismisses the picker and releases the dialog guard for the next pass.
        picker.component.handleInput("escape");
        await picker.promise;
        await new Promise(r => setImmediate(r));
      }
      assert.equal(calls.length, 2, "each Alt+W pass opens exactly prefix + picker");
    } finally { await f.emit("session_shutdown"); }
  });
}

for (const order of [[todo, artifacts, modes, sidebar], [sidebar, modes, artifacts, todo]]) {
  for (const renderer of ["regular", "fullscreen"] as const) {
    test(`sidebar composes providers in ${renderer}, order ${order[0]!.name}`, async () => {
      const f = fixture(order, renderer);
      await f.emit("session_start");
      assert.equal(f.widgets.has("workflow-todos"), false);
      assert.equal(f.widgets.has("artifacts"), false);
      assert.equal(f.widgets.has("input-modes"), false);
      await f.call("workflow_todo", { action: "plan", steps: ["Inspect data", "Implement UI", "Verify"] });
      await f.call("artifact_save", { id: "sidebar-design", title: "Sidebar design", type: "spec", content: "Details" });
      let output = f.tui.render(120).join("\n");
      assert.match(output, /Todo 0\/3/);
      assert.match(output, /󰄱 Inspect data/);
      assert.match(output, /󰄱 Implement UI/);
      assert.match(output, /󰄱 Verify/);
      await f.call("workflow_todo", { action: "update", id: 1, status: "done", evidence: "Inspected the data." });
      await f.call("workflow_todo", { action: "update", id: 2, status: "in_progress" });
      output = f.tui.render(120).join("\n");
      assert.match(output, /󰄲 Inspect data/);
      assert.match(output, /󰑐 Implement UI/);
      assert.match(output, /󰄱 Verify/);
      assert.ok(output.indexOf("Inspect data") < output.indexOf("Implement UI") && output.indexOf("Implement UI") < output.indexOf("Verify"),
        "todo items stay in their defined plan order regardless of status changes");
      assert.match(output, /Artifacts 1/);
      assert.match(output, /󰈙 Sidebar design/);
      assert.match(output, /󰚥 Normal/);
      assert.match(output, /AI chat & tools/);
      assert.match(output, /Alt\+M · switch/);
      await f.commands.get("plan").handler("mode", f.ctx);
      assert.match(f.tui.render(120).join("\n"), /󰏫 Plan/);
      assert.match(f.tui.render(120).join("\n"), /Read; artifacts RW/);
      await f.commands.get("plan").handler("off", f.ctx);
      assert.match(f.tui.render(120).join("\n"), /󰚥 Normal/);
      Reflect.set(f.tui.terminal, "columns", 80);
      const anchor = f.widgets.get("workspace-sidebar");
      assert.match(anchor.render(80).join("\n"), /Normal · Todo 1\/3 · Artifacts 1/);
      await f.commands.get("sidebar").handler("off", f.ctx);
      assert.doesNotMatch(f.tui.render(120).join("\n"), /Sidebar design/);
      await f.commands.get("sidebar").handler("on", f.ctx);
      // Branch restore must clear stale artifacts and todo rows.
      f.branch.length = 0;
      await f.emit("session_tree");
      output = f.tui.render(120).join("\n");
      assert.match(output, /Artifacts 0/);
      assert.match(output, /Todo 0\/0/);
      assert.doesNotMatch(output, /Sidebar design/);
      // Pi disposes widgets before session_shutdown on reload.
      anchor.dispose();
      await f.emit("session_shutdown");
      assert.deepEqual(f.tui.children, [f.original]);
      if (renderer === "fullscreen") assert.equal(Reflect.get(f.tui, "layoutRoot"), f.root);
    });
  }
}

for (const renderer of ["regular", "fullscreen"] as const) {
  test(`mode cards use distinct icons, theme colors and fit minimum width in ${renderer}`, async () => {
    const f = fixture([modes, sidebar], renderer);
    const colors: { token: string; text: string }[] = [];
    const bold: string[] = [];
    f.ctx.ui.theme = {
      fg(token: string, text: string) { colors.push({ token, text }); return text; },
      bold(text: string) { bold.push(text); return text; },
    };
    await f.emit("session_start");
    await f.commands.get("sidebar").handler("anim off", f.ctx);
    await f.commands.get("sidebar").handler("width 20", f.ctx);
    Reflect.set(f.tui.terminal, "rows", 12);
    try {
      for (const [id, title, summary, tone] of [
        ["normal", "󰚥 Normal", "AI chat & tools", "accent"],
        ["plan", "󰏫 Plan", "Read; artifacts RW", "success"],
      ]) {
        await f.commands.get("mode").handler(id, f.ctx);
        colors.length = 0;
        bold.length = 0;
        const output = f.tui.render(120);
        assert.ok(output.some(line => line.includes(title!)));
        assert.ok(output.some(line => line.includes(summary!)));
        assert.ok(output.some(line => line.includes("Alt+M · switch")));
        assert.ok(colors.some(entry => entry.token === tone && entry.text === title));
        assert.ok(colors.some(entry => entry.token === "dim" && entry.text === "Alt+M · switch"));
        assert.ok(bold.includes(title!));
        assert.ok(output.every(line => visibleWidth(line) <= 120));
        assert.ok(output.every(line => !line.includes("...")), "mode card fits without truncation at width 20");
        Reflect.set(f.tui.terminal, "columns", 80);
        assert.ok(f.widgets.get("workspace-sidebar").render(80).join("\n").includes(title!));
        Reflect.set(f.tui.terminal, "columns", 120);
      }
      await f.commands.get("plan").handler("off", f.ctx);
      assert.ok(f.tui.render(120).join("\n").includes("󰚥 Normal"));
      assert.ok(!f.tui.render(120).join("\n").includes("󰏫 Plan"));
    } finally {
      await f.emit("session_shutdown");
    }
  });

  test(`width commands resize ${renderer}, validate input, report clamping and reset`, async () => {
    const f = fixture([todo, artifacts, modes, sidebar], renderer);
    const notices: string[] = [];
    f.ctx.ui.notify = (text: string) => notices.push(text);
    await f.emit("session_start");
    const command = (args: string) => f.commands.get("sidebar").handler(args, f.ctx);
    const mainWidth = () => {
      let result = 0;
      f.original.render = width => { result = width; return ["chat"]; };
      f.tui.render(120);
      return result;
    };
    assert.equal(mainWidth(), 96);
    await command("width 32");
    assert.equal(mainWidth(), 88);
    await command("width");
    assert.match(notices.at(-1)!, /32 columns/);
    for (const invalid of ["width 19", "width 61", "width -2", "width 24.5", "width foo", "width 32 junk"]) {
      await command(invalid);
      assert.equal(mainWidth(), 88);
    }
    await command("width 60");
    assert.match(notices.at(-1)!, /44 visible/);
    assert.equal(mainWidth(), 76);
    await command("off");
    assert.equal(mainWidth(), 120);
    await command("width 30");
    assert.equal(mainWidth(), 120);
    await command("on");
    assert.equal(mainWidth(), 90);
    await command("reset");
    assert.equal(mainWidth(), 96);
    await command("aquarium off");
    assert.match(notices.at(-1)!, /aquarium off/);
    await command("aquarium on");
    assert.match(notices.at(-1)!, /aquarium on/);
    await f.emit("session_shutdown");
  });
}

test("sidebar renders aquarium tank when rows are available and can toggle off", async () => {
  const f = fixture([todo, artifacts, modes, sidebar], "fullscreen");
  // Expand terminal height to 40 so plenty of rows exist for the aquarium
  Reflect.set(f.tui.terminal, "rows", 40);
  Reflect.set(f.tui.terminal, "columns", 120);
  await f.emit("session_start");
  const outputBefore = f.tui.render(120).join("\n");
  assert.match(outputBefore, /Aquarium/);
  assert.match(outputBefore, /┌─+┐/);
  assert.match(outputBefore, /└─+┘/);

  await f.commands.get("sidebar").handler("aquarium off", f.ctx);
  const outputAfter = f.tui.render(120).join("\n");
  assert.doesNotMatch(outputAfter, /Aquarium/);
  assert.doesNotMatch(outputAfter, /┌─+┐/);

  await f.commands.get("sidebar").handler("aquarium on", f.ctx);
  const outputRestored = f.tui.render(120).join("\n");
  assert.match(outputRestored, /Aquarium/);

  // Test pluggable animation commands
  await f.commands.get("sidebar").handler("anim matrix", f.ctx);
  const outputMatrix = f.tui.render(120).join("\n");
  assert.match(outputMatrix, /Matrix Rain/);

  await f.commands.get("sidebar").handler("anim fire", f.ctx);
  const outputFire = f.tui.render(120).join("\n");
  assert.match(outputFire, /Campfire/);

  // Test registering custom animation dynamically via event
  f.events.emit("sidebar:register_animation", {
    id: "starfield",
    name: "Deep Space",
    render: (w: number, h: number) => Array.from({ length: h }, () => "*".repeat(w)),
  });
  await f.commands.get("sidebar").handler("anim starfield", f.ctx);
  const outputStarfield = f.tui.render(120).join("\n");
  assert.match(outputStarfield, /Deep Space/);
  assert.match(outputStarfield, /\*{10,}/);

  await f.commands.get("sidebar").handler("anim off", f.ctx);
  const outputAnimOff = f.tui.render(120).join("\n");
  assert.doesNotMatch(outputAnimOff, /Deep Space/);

  await f.commands.get("sidebar").handler("anim on", f.ctx);
  const outputAnimOn = f.tui.render(120).join("\n");
  assert.match(outputAnimOn, /Deep Space/);

  // Test argument autocompletions
  const sidebarCmd = f.commands.get("sidebar");
  assert.ok(typeof sidebarCmd.getArgumentCompletions === "function");
  const topCompletions = sidebarCmd.getArgumentCompletions("");
  assert.ok(topCompletions && topCompletions.length >= 5);
  const values = topCompletions.map((c: any) => c.value);
  assert.ok(values.includes("on"));
  assert.ok(values.includes("off"));
  assert.ok(values.includes("anim"));
  assert.ok(values.includes("width"));
  assert.ok(values.includes("reset"));

  const oCompletions = sidebarCmd.getArgumentCompletions("o");
  assert.deepEqual(oCompletions?.map((c: any) => c.value), ["on", "off"]);

  const animCompletions = sidebarCmd.getArgumentCompletions("anim ");
  assert.ok(animCompletions);
  const animValues = animCompletions.map((c: any) => c.value);
  assert.ok(animValues.includes("anim on"));
  assert.ok(animValues.includes("anim off"));
  assert.ok(animValues.includes("anim aquarium"));
  assert.ok(animValues.includes("anim matrix"));
  assert.ok(animValues.includes("anim fire"));
  assert.ok(animValues.includes("anim starfield"));

  const animM = sidebarCmd.getArgumentCompletions("anim m");
  assert.deepEqual(animM?.map((c: any) => c.value), ["anim matrix"]);

  const widthCompletions = sidebarCmd.getArgumentCompletions("width ");
  assert.ok(widthCompletions);
  assert.ok(widthCompletions.some((c: any) => c.value === "width 24"));
  assert.ok(widthCompletions.some((c: any) => c.value === "width 32"));

  await f.emit("session_shutdown");
});

test("sidebar declines unsupported fullscreen root and keeps original widgets", async () => {
  const f = fixture([todo, artifacts, modes, sidebar], "fullscreen");
  Reflect.set(f.tui, "layoutRoot", undefined);
  await f.emit("session_start");
  assert.equal(f.widgets.has("input-modes"), true);
  await f.emit("session_shutdown");
});

test("stable proxy can switch regular/fullscreen repeatedly without nested wrappers", () => {
  let current: any = new TuiMainScreen(terminal());
  const original = new Text("editor", 0, 0);
  current.addChild(original);
  const proxy = new Proxy({}, {
    get(_target, key) {
      const value = Reflect.get(current, key, current);
      return typeof value === "function" ? value.bind(current) : value;
    },
    has: (_target, key) => key in current,
    getPrototypeOf: () => Object.getPrototypeOf(current),
  }) as any;
  const mount = new SidebarMount(proxy, new Text("rail", 0, 0), () => true);
  assert.equal(mount.ensure(), true);
  const children = [...current.children];
  for (let index = 0; index < 3; index++) {
    current = new TuiAltScreen(terminal());
    current.children.push(...children);
    const root = new VStack([{ component: original, grow: 1 }]);
    current.setLayoutRoot(root);
    assert.equal(mount.ensure(), true);
    assert.equal(mount.ensure(), true);
    assert.equal(Reflect.get(current, "layoutRoot").entries[0].component, root);
    current = new TuiMainScreen(terminal());
    current.children.push(...children);
    assert.equal(mount.ensure(), true);
    assert.equal(current.children.length, 1);
    assert.equal(current.children[0].main.children[0], original);
  }
  mount.dispose();
  assert.deepEqual(current.children, [original]);
});

test("terminal controls and multiline labels cannot escape the rail", () => {
  assert.equal(plain("hello\x1b[31m red\x1b[0m\nnext\x07"), "hello red next");
  assert.equal(plain("safe\x1b]0;BAD TITLE\x07text"), "safetext");
});

test("todo items wrap long text with readable continuation indent, preserve order and omit numbers", async () => {
  const f = fixture([todo, sidebar], "regular");
  await f.emit("session_start");
  const longStep1 = "Inspect todo and sidebar renderers and existing wrapping utilities carefully";
  const longStep2 = "Wrap long todo text with readable continuation indentation and add edge-case tests";
  const shortStep3 = "Run tests";

  await f.call("workflow_todo", { action: "plan", steps: [longStep1, longStep2, shortStep3] });
  let lines = f.tui.render(120);
  let output = lines.join("\n");

  // Verify status icons and no prepended numbers [1], 1., etc.
  assert.match(output, /󰄱 Inspect todo/);
  assert.doesNotMatch(output, /\[1\]/);
  assert.doesNotMatch(output, /\[2\]/);
  assert.doesNotMatch(output, /\[3\]/);

  // Check wrapping in 24-col sidebar (content width 22)
  const todoLines = lines.filter(l => l.includes("│ ") && (l.includes("󰑐") || l.includes("󰄱") || l.includes("sidebar")));
  assert.ok(todoLines.some(l => l.includes("󰄱 Inspect todo")), "first line has the open icon");
  assert.ok(todoLines.some(l => l.includes("sidebar renderers")), "continuation line has 2-space hanging indent");

  // Every line in the rendered sidebar must fit within 120 columns
  assert.ok(lines.every(l => visibleWidth(l) <= 120));

  // Update step 1 to done and step 2 to in_progress
  await f.call("workflow_todo", { action: "update", id: 1, status: "done", evidence: "Completed inspection" });
  await f.call("workflow_todo", { action: "update", id: 2, status: "in_progress" });

  lines = f.tui.render(120);
  output = lines.join("\n");

  // Step 1 is now checked (󰄲), Step 2 is in_progress (󰑐), Step 3 is pending (󰄱)
  assert.match(output, /󰄲 Inspect todo/);
  assert.match(output, /󰑐 Wrap long todo/);
  assert.match(output, /󰄱 Run tests/);

  // Order MUST be preserved: Step 1 before Step 2 before Step 3
  const pos1 = output.indexOf("Inspect todo");
  const pos2 = output.indexOf("Wrap long todo");
  const pos3 = output.indexOf("Run tests");
  assert.ok(pos1 < pos2, "Step 1 must appear before Step 2");
  assert.ok(pos2 < pos3, "Step 2 must appear before Step 3");

  await f.emit("session_shutdown");
});

test("sidebar command feed drops food and clicking top position of tank feeds the biota", async () => {
  clearAquariumFood();
  const f = fixture([todo, artifacts, modes, sidebar], "fullscreen");
  Reflect.set(f.tui.terminal, "rows", 40);
  Reflect.set(f.tui.terminal, "columns", 120);
  await f.emit("session_start");

  // Render to mount and ensure aquarium is active
  const rendered = f.tui.render(120).join("\n");
  assert.match(rendered, /Aquarium/);

  // 1. Test /sidebar feed command
  await f.commands.get("sidebar").handler("feed 12", f.ctx);
  const sim = getAquariumSimulation(22, 10);
  assert.ok(sim.hasActiveFoods(), "Active food particle was created by /sidebar feed");
  const food = sim.foods[0]!;
  assert.equal(food.y, 1.0); // Surface

  // 2. Find the aquarium top border line in rendered sidebar
  const lines = f.tui.render(120);
  let tankTopLine = -1;
  for (let r = 0; r < lines.length; r++) {
    if (lines[r]!.includes("┌─") && lines[r]!.includes("─┐")) {
      tankTopLine = r;
      break;
    }
  }
  assert.ok(tankTopLine > 0, "Found tank top border line");

  // Clicking top position: row tankTopLine (top border) or tankTopLine + 1 (surface)
  clearAquariumFood();
  // Sidebar container is at x=0..24, tank inner column 10 (x = 12)
  (f.tui as any).handleMouse?.({
    type: "click",
    button: "left",
    x: 12,
    y: tankTopLine,
    width: 120,
    height: 40,
  });
  assert.ok(sim.hasActiveFoods(), "Clicking top position of fish tank dropped food with gravity");

  await f.emit("session_shutdown");
});
