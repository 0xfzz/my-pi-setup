import test from "node:test";
import assert from "node:assert/strict";

import {
  WEB_PLUGIN_ACTION_REQUEST_EVENT,
  MAX_ACTIONS,
  validateActions,
  type ActionDescriptor,
  type ActionRequestPayload,
} from "../lib/web-plugins/actions.ts";

import {
  validatePlugin,
  type WebPluginDescriptor,
} from "../lib/web-plugins/descriptor.ts";

import {
  validateRegistry,
  WEB_PLUGIN_ACTION_REQUEST_EVENT as REGISTRY_ACTION_EVENT,
  validateActions as registryValidateActions,
  type ActionDescriptor as RegistryActionDescriptor,
  type ActionRequestPayload as RegistryActionPayload,
} from "../lib/web-plugins/registry.ts";
import { WEB_PLUGINS } from "../web-plugins/index.ts";
import { subagentMonitorPlugin } from "../web-plugins/subagent-monitor.ts";
import dashboardExtension from "../extensions/dashboard.ts";

test("registry re-exports action constants and types", () => {
  assert.equal(REGISTRY_ACTION_EVENT, WEB_PLUGIN_ACTION_REQUEST_EVENT);
  assert.equal(registryValidateActions, validateActions);
  const sampleDescriptor: RegistryActionDescriptor = {
    id: "sample",
    title: "Sample",
    confirm: "sample",
  };
  assert.equal(sampleDescriptor.id, "sample");
  const samplePayload: RegistryActionPayload = {
    requestId: "req-1",
    sessionId: "sess-1",
    pluginId: "subagent-monitor",
    actionId: "request-sync",
  };
  assert.equal(samplePayload.requestId, "req-1");
});

test("validateActions: valid action descriptors pass", () => {
  const emptyRes = validateActions([]);
  assert.equal(emptyRes.ok, true);
  if (emptyRes.ok) {
    assert.deepEqual(emptyRes.actions, []);
  }

  const singleAction: ActionDescriptor = {
    id: "request-sync",
    title: "Request fresh snapshot",
    confirm: "request sync",
  };
  const singleRes = validateActions([singleAction]);
  assert.equal(singleRes.ok, true);
  if (singleRes.ok) {
    assert.deepEqual(singleRes.actions, [singleAction]);
  }

  const multiRes = validateActions([
    { id: "action-one", title: "Action 1", confirm: "one" },
    { id: "action-two", title: "Action 2", confirm: "two" },
  ]);
  assert.equal(multiRes.ok, true);
  if (multiRes.ok) {
    assert.equal(multiRes.actions.length, 2);
  }
});

test("validateActions: invalid actions are rejected", () => {
  // Non-array
  assert.equal(validateActions(null).ok, false);
  assert.equal(validateActions(undefined).ok, false);
  assert.equal(validateActions("not an array").ok, false);
  assert.equal(validateActions({}).ok, false);

  // Exceeds MAX_ACTIONS (8)
  const tooMany = Array.from({ length: MAX_ACTIONS + 1 }, (_, i) => ({
    id: `action-${i}`,
    title: `Action ${i}`,
    confirm: `confirm-${i}`,
  }));
  const tooManyRes = validateActions(tooMany);
  assert.equal(tooManyRes.ok, false);
  if (!tooManyRes.ok) {
    assert.match(tooManyRes.error, /cannot exceed 8 actions/);
  }

  // Non-object action item
  assert.equal(validateActions([null]).ok, false);
  assert.equal(validateActions(["not an object"]).ok, false);
  assert.equal(validateActions([[]]).ok, false);

  // Invalid id (must match ^[a-z][a-z0-9-]*$)
  assert.equal(validateActions([{ id: "123invalid", title: "T", confirm: "c" }]).ok, false);
  assert.equal(validateActions([{ id: "Upper-Case", title: "T", confirm: "c" }]).ok, false);
  assert.equal(validateActions([{ id: "has spaces", title: "T", confirm: "c" }]).ok, false);
  assert.equal(validateActions([{ id: "", title: "T", confirm: "c" }]).ok, false);
  assert.equal(validateActions([{ id: "bad_underscore", title: "T", confirm: "c" }]).ok, false);

  // Missing or empty title
  assert.equal(validateActions([{ id: "valid-id", title: "", confirm: "c" }]).ok, false);
  assert.equal(validateActions([{ id: "valid-id", title: "   ", confirm: "c" }]).ok, false);
  assert.equal(validateActions([{ id: "valid-id", title: 123, confirm: "c" }]).ok, false);

  // Missing or empty confirm (an omitted confirm is the instant-action form)
  assert.equal(validateActions([{ id: "valid-id", title: "Title", confirm: "" }]).ok, false);
  assert.equal(validateActions([{ id: "valid-id", title: "Title", confirm: "   " }]).ok, false);
  assert.equal(validateActions([{ id: "valid-id", title: "Title", confirm: null }]).ok, false);

  // Invalid keybindings: a bare key, trailing keys, lowercase, or junk
  assert.equal(validateActions([{ id: "valid-id", title: "Title", keybinding: "M" }]).ok, false);
  assert.equal(validateActions([{ id: "valid-id", title: "Title", keybinding: "alt+m" }]).ok, false);
  assert.equal(validateActions([{ id: "valid-id", title: "Title", keybinding: "Alt+M+X" }]).ok, false);
  assert.equal(validateActions([{ id: "valid-id", title: "Title", keybinding: "Alt" }]).ok, false);
  assert.equal(validateActions([{ id: "valid-id", title: "Title", keybinding: 9 }]).ok, false);
});

test("validateActions: an omitted confirm marks an instant action, and a keybinding rides along", () => {
  const res = validateActions([
    { id: "toggle-mode", title: "Switch mode", keybinding: "Alt+M" },
    { id: "toggle-panel", title: "Toggle panel", keybinding: "Ctrl+Shift+9" },
  ]);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.actions[0], { id: "toggle-mode", title: "Switch mode", keybinding: "Alt+M" });
    assert.deepEqual(res.actions[1], { id: "toggle-panel", title: "Toggle panel", keybinding: "Ctrl+Shift+9" });
  }
});

test("validatePlugin: accepts valid actions and rejects malformed actions", () => {
  const known = ["dashboard.ts"];

  const validDescriptor: WebPluginDescriptor = {
    id: "dashboard",
    extension: "dashboard",
    title: "Dashboard",
    surfaces: [{ kind: "sidebar" }],
    actions: [
      { id: "request-sync", title: "Request fresh snapshot", confirm: "request sync" },
    ],
  };

  const okResult = validatePlugin(validDescriptor, known);
  assert.equal(okResult.ok, true);
  if (okResult.ok) {
    assert.ok(okResult.plugin.actions);
    assert.equal(okResult.plugin.actions.length, 1);
    assert.equal(okResult.plugin.actions[0].id, "request-sync");
  }

  // Malformed actions
  const badResult = validatePlugin(
    {
      ...validDescriptor,
      actions: [{ id: "BAD-ID", title: "Title", confirm: "confirm" }],
    },
    known,
  );
  assert.equal(badResult.ok, false);
  if (!badResult.ok) {
    assert.match(badResult.error, /id must match/);
  }

  // Actions not an array
  const notArrayResult = validatePlugin(
    {
      ...validDescriptor,
      actions: "not-an-array",
    },
    known,
  );
  assert.equal(notArrayResult.ok, false);
});

test("validateRegistry: rejects duplicate action ids within a plugin", () => {
  const known = ["dashboard.ts"];
  const pluginWithDups: WebPluginDescriptor = {
    id: "dashboard",
    extension: "dashboard",
    title: "Dashboard",
    surfaces: [{ kind: "sidebar" }],
    actions: [
      { id: "duplicate-id", title: "First", confirm: "first" },
      { id: "duplicate-id", title: "Second", confirm: "second" },
    ],
  };

  const errors = validateRegistry([pluginWithDups], known);
  assert.ok(errors.length > 0, "must report duplicate action id error");
  assert.ok(
    errors.some((err) => err.includes('Plugin "dashboard": duplicate action id "duplicate-id"')),
    `Expected duplicate action id error, got: ${errors.join("; ")}`,
  );
});

test("WEB_PLUGINS contains the subagent monitor plugin with exactly the declared reference action", () => {
  assert.equal(subagentMonitorPlugin.id, "subagent-monitor");
  assert.ok(subagentMonitorPlugin.actions, "the monitor plugin must declare actions");
  assert.equal(subagentMonitorPlugin.actions.length, 1);
  assert.deepEqual(subagentMonitorPlugin.actions[0], {
    id: "request-sync",
    title: "Request fresh snapshot",
    confirm: "request sync",
  });

  const registeredMonitor = WEB_PLUGINS.find((p) => p.id === "subagent-monitor");
  assert.ok(registeredMonitor, "the subagent monitor plugin must be present in WEB_PLUGINS");
  assert.deepEqual(registeredMonitor.actions, [
    {
      id: "request-sync",
      title: "Request fresh snapshot",
      confirm: "request sync",
    },
  ]);
});

test("AC4: dashboard extension ignores unrecognised action requests and guards payload content", () => {
  const eventHandlers = new Map<string, (data: unknown) => void>();
  let syncEmitted = false;
  let sessionStartListener: ((event: unknown, ctx: unknown) => void) | undefined;

  const mockPi = {
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        eventHandlers.set(channel, handler);
        return () => {
          eventHandlers.delete(channel);
        };
      },
      emit(channel: string) {
        if (channel === "dashboard:sync") {
          syncEmitted = true;
        }
      },
    },
    registerTool: () => {},
    registerCommand: () => {},
    on: (eventName: string, handler: any) => {
      if (eventName === "session_start") sessionStartListener = handler;
    },
    setSessionName: () => {},
    appendEntry: () => {},
  };

  dashboardExtension(mockPi as any, {
    producerFactory: async () => ({
      publish: () => {},
      close: () => {},
    }),
  });

  const actionHandler = eventHandlers.get(WEB_PLUGIN_ACTION_REQUEST_EVENT);
  assert.ok(actionHandler, "dashboardExtension must register listener for WEB_PLUGIN_ACTION_REQUEST_EVENT");

  // Simulate context binding as verified parent session
  const mockContext = {
    sessionManager: {
      getBranch: () => [],
      getHeader: () => ({ id: "parent-session" }),
      getSessionId: () => "parent-session",
    },
  };

  assert.ok(sessionStartListener);
  sessionStartListener({}, mockContext);

  // 1. Unknown pluginId -> ignored
  syncEmitted = false;
  actionHandler({ pluginId: "not-subagent-monitor", actionId: "request-sync" });
  assert.equal(syncEmitted, false, "Must ignore unknown pluginId");

  // 2. Unknown actionId -> ignored
  syncEmitted = false;
  actionHandler({ pluginId: "subagent-monitor", actionId: "unknown-action" });
  assert.equal(syncEmitted, false, "Must ignore unknown actionId");

  // 3. Garbage / null payload -> ignored
  syncEmitted = false;
  actionHandler(null);
  actionHandler(undefined);
  actionHandler("string-payload");
  assert.equal(syncEmitted, false, "Must ignore malformed payload");

  // 4. Valid pluginId and actionId -> triggers sync
  syncEmitted = false;
  const validPayload: ActionRequestPayload = {
    requestId: "uuid-123",
    sessionId: "sess-1",
    pluginId: "subagent-monitor",
    actionId: "request-sync",
  };
  actionHandler({
    ...validPayload,
    extraUntrustedContent: "should-be-ignored",
  });
  assert.equal(syncEmitted, true, "Must trigger requestDashboardSync on valid match");
});

test("phase 6 slot surfaces: validation and placement mapping", () => {
  const known = ["cache-stats.ts", "todo.ts", "artifacts.ts", "subagent-checkpoints.ts", "dashboard.ts", "example-override.ts"];

  // Valid slot surfaces
  for (const slot of ["top", "center", "bottom", "floating"] as const) {
    const res = validatePlugin(
      {
        id: "test-plugin",
        extension: "cache-stats",
        title: "Test",
        surfaces: [{ kind: "slot", slot }],
      },
      known,
    );
    assert.equal(res.ok, true);
  }

  // Invalid slot value rejected
  const badSlotRes = validatePlugin(
    {
      id: "test-plugin",
      extension: "cache-stats",
      title: "Test",
      surfaces: [{ kind: "slot", slot: "sidebar" as never }],
    },
    known,
  );
  assert.equal(badSlotRes.ok, false);
  assert.match(badSlotRes.error, /invalid slot/);

  // Placements match the intended Phase 6 mapping
  const expectedPlacements: Record<string, string> = {
    "cache-stats": "bottom",
    todo: "top",
    artifacts: "floating",
    "subagent-checkpoints": "center",
  };

  for (const [id, expectedSlot] of Object.entries(expectedPlacements)) {
    const plugin = WEB_PLUGINS.find((p) => p.id === id);
    assert.ok(plugin, `Plugin ${id} must exist in WEB_PLUGINS`);
    const slotSurface = plugin.surfaces.find((s) => s.kind === "slot");
    assert.ok(slotSurface && slotSurface.kind === "slot", `${id} must have a slot surface`);
    assert.equal(slotSurface.slot, expectedSlot, `${id} must be in slot ${expectedSlot}`);
  }

  // The subagent monitor keeps its page surface
  const monitor = WEB_PLUGINS.find((p) => p.id === "subagent-monitor");
  assert.ok(monitor, "the subagent monitor must exist in WEB_PLUGINS");
  const pageSurface = monitor.surfaces.find((s) => s.kind === "page");
  assert.ok(pageSurface && pageSurface.kind === "page", "the monitor must keep its page surface");
  assert.equal(pageSurface.path, "/plugins/subagent-monitor");
});

test("override surfaces validate against the region vocabulary", () => {
  const known = ["cache-stats.ts", "todo.ts", "artifacts.ts", "subagent-checkpoints.ts", "dashboard.ts", "example-override.ts"];

  for (const region of ["header", "status", "transcript", "composer"] as const) {
    const valid = validatePlugin(
      {
        id: "override-demo",
        extension: "cache-stats",
        title: "Override demo",
        surfaces: [{ kind: "override", region }],
      },
      known,
    );
    assert.ok(valid.ok, `region ${region} must validate`);
  }

  for (const bad of ["sidebar", "top", "nonsense"]) {
    const invalid = validatePlugin(
      {
        id: "override-demo",
        extension: "cache-stats",
        title: "Override demo",
        surfaces: [{ kind: "override", region: bad }],
      },
      known,
    );
    assert.equal(invalid.ok, false, `region ${bad} must be rejected`);
    assert.match(invalid.error, /invalid override region/);
  }

  // The reference plugin is registered and passes the same validation.
  const example = WEB_PLUGINS.find((p) => p.id === "example-override");
  assert.ok(example, "the example-override plugin must be registered");
  const overrideSurface = example?.surfaces.find((s) => s.kind === "override");
  assert.ok(overrideSurface && overrideSurface.kind === "override");
  assert.equal(overrideSurface.region, "composer");
  assert.equal(example?.actions?.some((a) => a.id === "replace-composer"), true);
});
