import { Text, TuiAltScreen, VStack, isViewportTUI, ScrollView } from "@earendil-works/pi-tui";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { SidebarMount } from "../../lib/sidebar-layout.ts";

/**
 * Mount the sidebar against whichever Pi release the test runner resolved.
 *
 * This lives in `fixtures/` because it must be imported through the host's alias
 * map (see `tests/sidebar-version-compat.test.ts`), which points the
 * `@earendil-works/*` specifiers at the installed release. Importing it directly
 * from a test file would resolve this package's peer copies instead and quietly
 * verify the wrong version — exactly the blind spot that let an equality-pinned
 * version check break the sidebar on 1.4.0.
 */

const terminal = (): any => ({
  columns: 120, rows: 24,
  write() {}, start() {}, stop() {}, showCursor() {}, hideCursor() {}, moveBy() {},
  clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {},
  getCellSize() { return undefined; },
});

export function probeFullscreenMount(expectedVersion?: string) {
  const tui: any = new TuiAltScreen(terminal());
  const scroll = new ScrollView(new Text(Array(60).fill("message").join("\n"), 0, 0), { primary: true });
  const root = new VStack([{ component: scroll, grow: 1 }]);
  tui.setLayoutRoot(root);
  scroll.updateLayout(100, 24, () => {});

  const mount = new SidebarMount(tui, new Text("SIDEBAR", 0, 0), () => true);
  const ensured = mount.ensure();
  const rendered = tui.render(120).some((line: string) => line.includes("SIDEBAR"));
  const wrappedRoot = Reflect.get(tui, "layoutRoot") !== root;
  mount.dispose();
  const disposeRestoredRoot = Reflect.get(tui, "layoutRoot") === root;

  return {
    requestedVersion: expectedVersion,
    seenVersion: VERSION,
    tuiMode: tui.mode,
    isViewportTUI: isViewportTUI(tui),
    hasLayoutRoot: Boolean(Reflect.get(tui, "layoutRoot")),
    hasSetLayoutRoot: typeof Reflect.get(tui, "setLayoutRoot"),
    ensured,
    rendered,
    wrappedRoot,
    disposeRestoredRoot,
  };
}
