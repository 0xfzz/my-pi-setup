import test from "node:test";
import assert from "node:assert/strict";
import { Container, Text, TuiAltScreen, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { SidebarMount, SidebarSplit } from "../lib/sidebar/sidebar-layout.ts";
import { SidebarResizer } from "../lib/sidebar/sidebar-resize.ts";

const terminal = () => ({ columns: 120, rows: 24, write() {} }) as any;
const mouse = (type: TuiMouseEvent["type"], screenX: number, overrides = {}): TuiMouseEvent => ({
  type, screenX, screenY: 5, x: 0, y: 5, width: 24, height: 24,
  button: "left", shift: false, alt: false, ctrl: false, ...overrides,
});

test("divider captures only primary unmodified presses without requesting focus", () => {
  const r = new SidebarResizer(() => 120, () => true, () => assert.fail("Press should not resize"));
  for (const overrides of [{ x: 1 }, { button: "right" }, { shift: true }, { alt: true }, { ctrl: true }]) {
    assert.equal(r.handleMouse(mouse("press", 96, overrides)), undefined);
  }
  assert.equal(r.handleMouse(mouse("wheel", 96, { button: "none" })), undefined);
  assert.deepEqual(r.handleMouse(mouse("press", 96)), { capture: true, render: true });
  assert.equal(r.dragging, true);
  assert.deepEqual(r.handleMouse(mouse("release", 96)), { handled: true, render: true });
  assert.equal(r.dragging, false);
});

test("captured drag uses absolute coordinates across moved bounds, clamps, and can return to start", () => {
  const widths: number[] = [];
  const r = new SidebarResizer(() => 120, () => true, width => widths.push(width));
  r.handleMouse(mouse("press", 96));
  r.handleMouse(mouse("drag", 88, { x: -8 }));
  r.handleMouse(mouse("drag", 96));
  r.handleMouse(mouse("drag", -100));
  r.handleMouse(mouse("drag", 200));
  r.handleMouse(mouse("release", 90));
  assert.deepEqual(widths, [32, 24, 44, 20, 30]);
  assert.equal(r.dragging, false);
  assert.equal(r.handleMouse(mouse("drag", 80)), undefined);
});

test("drag max is 60 on large terminals; collapse, cancellation and missing release are safe", () => {
  let available = true;
  const widths: number[] = [];
  const r = new SidebarResizer(() => 200, () => available, width => widths.push(width));
  r.handleMouse(mouse("press", 176));
  r.handleMouse(mouse("drag", 1));
  assert.deepEqual(widths, [60]);
  available = false;
  assert.equal(r.handleMouse(mouse("drag", 180)), undefined);
  assert.equal(r.dragging, false);
  available = true;
  r.handleMouse(mouse("press", 176));
  r.cancel();
  assert.equal(r.handleMouse(mouse("release", 180)), undefined);
  r.handleMouse(mouse("press", 176));
  r.handleMouse(mouse("move", 176, { button: "none" }));
  assert.equal(r.dragging, false);
});

test("regular resize preserves chat minimum, preferred width and full width when collapsed", () => {
  const main = new Container();
  let actual = 0;
  main.addChild({ render(width) { actual = width; return ["chat"]; }, invalidate() {} });
  let requested = 32;
  const split = new SidebarSplit(main, new Text("side", 0, 0), { terminal: terminal() }, () => true, () => requested);
  split.render(120); assert.equal(actual, 88);
  requested = 60;
  split.render(120); assert.equal(actual, 76);
  split.render(100); assert.equal(actual, 76);
  split.render(40); assert.equal(actual, 40);
  split.render(160); assert.equal(actual, 100);
});

test("fullscreen resizing changes only stack sizing, never the original root", () => {
  const tui = new TuiAltScreen(terminal());
  let actual = 0;
  const root = { render(width: number) { actual = width; return ["chat"]; }, invalidate() {} };
  tui.setLayoutRoot(root);
  let requested = 32;
  const mount = new SidebarMount(tui, new Text("side", 0, 0), () => true, () => requested);
  mount.ensure();
  const wrapper: any = Reflect.get(tui, "layoutRoot");
  wrapper.render(120); assert.equal(actual, 88);
  requested = 60; mount.ensure();
  assert.equal(Reflect.get(tui, "layoutRoot"), wrapper);
  wrapper.render(120); assert.equal(actual, 76);
  wrapper.render(100); assert.equal(actual, 76);
  assert.ok(wrapper.render(40).every((line: string) => visibleWidth(line) <= 40));
  assert.equal(actual, 40);
  wrapper.render(160); assert.equal(actual, 100);
  assert.equal(wrapper.entries[0].component, root);
  mount.dispose();
  assert.equal(Reflect.get(tui, "layoutRoot"), root);
});
