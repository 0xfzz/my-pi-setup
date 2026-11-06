import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { webUiStore } = await jiti.import("./web-plugins-host.ts");

test("actual RPC ctx.ui working methods emit validated session state and reset defaults", (t) => {
  webUiStore.clear();
  const inner = { sessionId: "working-bridge-test", sessionManager: { getCwd: () => "/tmp" }, isStreaming: false, isCompacting: false, isBashRunning: false, isIdle: true, agent: { state: {}, abort() {} }, abort() {}, dispose() {}, extensionRunner: {} };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const ui = wrapper.createExtensionUiContext();
  ui.setWorkingMessage("\x1b[31mRatiocinating...\x1b[0m");
  ui.setWorkingVisible(false);
  ui.setWorkingIndicator({ frames: ["·", "●"], intervalMs: 120 });
  assert.deepEqual(webUiStore.snapshot().sessions[inner.sessionId].working, { message: "Ratiocinating...", visible: false, frames: ["·", "●"], intervalMs: 120 });
  ui.setWorkingIndicator({ frames: ["x"], intervalMs: 1 });
  assert.equal(webUiStore.snapshot().sessions[inner.sessionId].working.intervalMs, 120);
  ui.setWorkingIndicator(); ui.setWorkingMessage(); ui.setWorkingVisible(true);
  assert.deepEqual(webUiStore.snapshot().sessions[inner.sessionId].working, { message: null, visible: true, frames: null, intervalMs: 80 });
  ui.setStatus("fixture", "Ready"); ui.setWidget("fixture", ["Line"]); ui.setTitle("Title"); ui.setEditorText("Draft");
  const state = webUiStore.snapshot().sessions[inner.sessionId];
  assert.equal(state.statuses.fixture, "Ready"); assert.deepEqual(state.widgets.fixture.lines, ["Line"]);
  assert.equal(state.title, "Title"); assert.equal(state.editor, "Draft");
});
