import test from "node:test";
import assert from "node:assert/strict";
import { startWebServer } from "./main.ts";
import {
  attachSessionPlugins,
  clearWebPluginStateForTests,
  getActionAuditLog,
  getPluginDescriptor,
  webPluginsStore,
  type MinimalEventBus,
} from "./plugin-host.ts";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT } from "../../../lib/web-plugins/actions.ts";

test.afterEach(() => {
  clearWebPluginStateForTests();
});

function attachActionBus(sessionId: string): Array<{ ch: string; data: unknown }> {
  const emissions: Array<{ ch: string; data: unknown }> = [];
  const bus: MinimalEventBus = {
    on: () => () => {},
    emit: (ch: string, data: unknown) => {
      emissions.push({ ch, data });
    },
  };
  attachSessionPlugins({ sessionId, inner: { resourceLoader: { eventBus: bus } } });
  return emissions;
}

async function withActionServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const handle = await startWebServer({ port: 0, host: "127.0.0.1" });
  try {
    await fn(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

async function postAction(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/plugins/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("action route 404s before validation for unknown session, plugin or action", async () => {
  attachActionBus("route-session");
  await withActionServer(async (baseUrl) => {
    const unknownSession = await postAction(baseUrl, {
      sessionId: "ghost-session",
      pluginId: "todo",
      actionId: "sync",
    });
    assert.equal(unknownSession.status, 404);
    assert.match((await unknownSession.json()).error, /Session not found/);

    const unknownPlugin = await postAction(baseUrl, {
      sessionId: "route-session",
      pluginId: "never-heard",
      actionId: "sync",
    });
    assert.equal(unknownPlugin.status, 404);

    const unknownAction = await postAction(baseUrl, {
      sessionId: "route-session",
      pluginId: "cache-stats",
      actionId: "not-an-action",
    });
    assert.equal(unknownAction.status, 404);

    assert.equal(getActionAuditLog().length, 0, "404s must not audit anything");
  });
});

test("action route requires the exact confirm string (403, nothing emitted)", async () => {
  const emissions = attachActionBus("confirm-session");
  const monitor = getPluginDescriptor("subagent-monitor");
  const action = monitor?.actions?.find((a) => a.confirm !== undefined);
  assert.ok(action, "subagent-monitor must declare a confirmed action");

  await withActionServer(async (baseUrl) => {
    const wrong = await postAction(baseUrl, {
      sessionId: "confirm-session",
      pluginId: "subagent-monitor",
      actionId: action.id,
      confirm: "totally wrong",
    });
    assert.equal(wrong.status, 403);
    assert.match((await wrong.json()).error, /Invalid confirmation string/);

    // The attach-sync request is an internal host signal, never a user action;
    // a 403 must not emit anything on the action channel.
    assert.equal(
      emissions.filter((e) => e.ch === WEB_PLUGIN_ACTION_REQUEST_EVENT).length,
      0,
      "a 403 must not emit to the bus",
    );
    assert.equal(getActionAuditLog().length, 0, "a 403 must not audit");
  });
});

test("action route relays confirmed actions with audit", async () => {
  const emissions = attachActionBus("relay-session");
  const monitor = getPluginDescriptor("subagent-monitor");
  const action = monitor?.actions?.find((a) => a.confirm !== undefined);
  assert.ok(action && action.confirm !== undefined);

  await withActionServer(async (baseUrl) => {
    const res = await postAction(baseUrl, {
      sessionId: "relay-session",
      pluginId: "subagent-monitor",
      actionId: action.id,
      confirm: action.confirm,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean; requestId?: string; relayed?: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.relayed, true);
    assert.ok(body.requestId);

    const request = emissions.find((e) => e.ch === WEB_PLUGIN_ACTION_REQUEST_EVENT);
    assert.ok(request, "the action request must reach the session bus");
    const data = request.data as { requestId?: string; sessionId?: string };
    assert.equal(data.requestId, body.requestId);
    assert.equal(data.sessionId, "relay-session");

    const audit = getActionAuditLog();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].requestId, body.requestId);
    assert.equal(audit[0].pluginId, "subagent-monitor");
  });
});

test("action route submits instant actions without a confirm", async () => {
  const emissions = attachActionBus("instant-session");
  const modes = getPluginDescriptor("modes");
  const instant = modes?.actions?.find((a) => a.confirm === undefined && a.keybinding !== undefined);
  assert.ok(instant, "modes must declare an instant keybound action");

  await withActionServer(async (baseUrl) => {
    const res = await postAction(baseUrl, {
      sessionId: "instant-session",
      pluginId: "modes",
      actionId: instant.id,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean; relayed?: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.relayed, true);
    assert.ok(emissions.some((e) => e.ch === WEB_PLUGIN_ACTION_REQUEST_EVENT));
  });
});

test("instant actions do not hold the in-flight lock (rapid mode toggling)", async () => {
  attachActionBus("instant-repeat-session");
  const modes = getPluginDescriptor("modes");
  const instant = modes?.actions?.find((a) => a.confirm === undefined && a.keybinding !== undefined);
  assert.ok(instant, "modes must declare an instant keybound action");

  await withActionServer(async (baseUrl) => {
    const first = await postAction(baseUrl, {
      sessionId: "instant-repeat-session",
      pluginId: "modes",
      actionId: instant.id,
    });
    assert.equal(first.status, 200, "the first toggle submits");

    // The moment the mode flips back, the user toggles again: an instant
    // action must not be refused by the 60 s lock meant for confirmed actions.
    const second = await postAction(baseUrl, {
      sessionId: "instant-repeat-session",
      pluginId: "modes",
      actionId: instant.id,
    });
    assert.equal(second.status, 200, "rapid instant toggles never hit the in-flight lock");
  });
});

test("action route enforces one in-flight CONFIRMED action per session (409)", async () => {
  const monitor = getPluginDescriptor("subagent-monitor");
  const action = monitor?.actions?.find((a) => a.confirm !== undefined);
  assert.ok(action && action.confirm !== undefined);
  attachActionBus("busy-session");

  await withActionServer(async (baseUrl) => {
    const first = await postAction(baseUrl, {
      sessionId: "busy-session",
      pluginId: "subagent-monitor",
      actionId: action.id,
      confirm: action.confirm,
    });
    assert.equal(first.status, 200);

    const second = await postAction(baseUrl, {
      sessionId: "busy-session",
      pluginId: "subagent-monitor",
      actionId: action.id,
      confirm: action.confirm,
    });
    assert.equal(second.status, 409);
    assert.match((await second.json()).error, /in flight/);
  });
});

test("action route reports relayed false when the session has no bus", async () => {
  // Known to the plugin store (via knownSessions) but no bus attached.
  webPluginsStore.knownSessions.add("views-only-session");
  const monitor = getPluginDescriptor("subagent-monitor");
  const action = monitor?.actions?.find((a) => a.confirm !== undefined);
  assert.ok(action && action.confirm !== undefined);

  await withActionServer(async (baseUrl) => {
    const res = await postAction(baseUrl, {
      sessionId: "views-only-session",
      pluginId: "subagent-monitor",
      actionId: action.id,
      confirm: action.confirm,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean; relayed?: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.relayed, false, "no bus means the request cannot be relayed");
  });
});

test("action route rejects non-POST and malformed bodies", async () => {
  attachActionBus("route-session");
  await withActionServer(async (baseUrl) => {
    const get = await fetch(`${baseUrl}/api/plugins/action`);
    assert.equal(get.status, 405);

    const malformed = await fetch(`${baseUrl}/api/plugins/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /Invalid JSON/);
  });
});
