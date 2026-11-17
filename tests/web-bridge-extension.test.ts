import test from "node:test";
import assert from "node:assert/strict";

import bridgeExtension, { BRIDGE_EXTENSION_ID } from "../extensions/bridge.ts";
import { BRIDGE_MESSAGE_EVENT, publishUiHeader } from "../web/core/protocol/publisher.ts";
import { WEB_UI_EVENT } from "../web/core/plugin-contracts/ui-event-models.ts";
import { bridgedSurfaceId, bridgedView } from "../web/plugins/web-bridge/bridge-view.ts";

interface FakeBus {
  handlers: Map<string, Array<(data: unknown) => void>>;
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

function fakeBus(): FakeBus {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  return {
    handlers,
    emit(channel, data) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on(channel, handler) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
      return () => handlers.set(channel, list.filter((entry) => entry !== handler));
    },
  };
}

function fakePi(bus: FakeBus) {
  return { events: bus, on: () => () => undefined } as never;
}

test("an unchanged extension's ui.status event becomes an attributed protocol envelope", () => {
  const bus = fakeBus();
  bridgeExtension(fakePi(bus));
  const emitted: Array<Record<string, unknown>> = [];
  bus.on(BRIDGE_MESSAGE_EVENT, (data) => emitted.push(data as Record<string, unknown>));
  bus.emit(WEB_UI_EVENT, { sourceKey: "other.ext", type: "ui.status.changed", payload: { key: "x", text: "ready" } });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.name, "ui.status.changed");
  assert.deepEqual(emitted[0]?.source, { type: "extension", id: "other.ext" });
});

test("the typed publisher adds header/footer envelopes with the extension id", () => {
  const bus = fakeBus();
  const result = publishUiHeader({ events: bus }, "fixture.ext", "Hello", "header-1");
  assert.equal(result.ok, true);
  const envelope = result.ok ? result.envelope : undefined;
  assert.equal(envelope?.name, "ui.header.changed");
  assert.deepEqual(envelope?.source, { type: "extension", id: "fixture.ext" });
});

test("the web bridge maps a bridged notice to a host-rendered view", () => {
  const bus = fakeBus();
  bridgeExtension(fakePi(bus));
  const views: Array<ReturnType<typeof bridgedView>> = [];
  bus.on(BRIDGE_MESSAGE_EVENT, (data) => views.push(bridgedView(data as never)));
  bus.emit(WEB_UI_EVENT, { sourceKey: "fixture.ext", type: "ui.title.changed", payload: { text: "New title" } });
  assert.equal(views.length, 1);
  assert.equal(views[0]?.type, "status");
  assert.match(views[0]?.type === "status" ? views[0].text : "", /fixture\.ext.*New title/);
  assert.equal(bridgedSurfaceId({ name: "ui.title.changed", source: { type: "extension", id: "fixture.ext" } } as never), "bridge:fixture.ext:ui.title.changed");
});

test("disabling the bridge extension removes its subscriptions only", () => {
  const bus = fakeBus();
  const unsubscribe = bus.on(WEB_UI_EVENT, () => undefined);
  bridgeExtension(fakePi(bus));
  const before = bus.handlers.get(WEB_UI_EVENT)?.length ?? 0;
  assert.ok(before >= 2);
  unsubscribe();
  assert.equal(bus.handlers.get(WEB_UI_EVENT)?.length, 1);
  assert.equal(BRIDGE_EXTENSION_ID, "bridge");
});
