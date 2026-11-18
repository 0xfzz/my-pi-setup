import test from "node:test";
import assert from "node:assert/strict";
import bridgeExtension, { BRIDGE_EXTENSION_ID } from "../extensions/bridge.ts";
import {
  BRIDGE_MESSAGE_EVENT,
  publishUiAutocompleteProvider,
  publishUiEditorComponent,
  publishUiFooter,
  publishUiHeader,
} from "../web/core/protocol/publisher.ts";
import { WEB_UI_EVENT } from "../web/core/plugin-contracts/ui-event-models.ts";
import { createHeadlessWebUiContext } from "../web/core/server/web-ui-context.ts";
import { bridgedSurfaceId, bridgedView } from "../web/plugins/web-bridge/bridge-view.ts";
import type { BridgeEnvelope } from "../web/core/protocol/envelope.ts";

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

type HeadlessUi = ReturnType<typeof createHeadlessWebUiContext>;

/** A third-party fixture: no web imports, no protocol calls, just ctx.ui. */
function unchangedFixtureExtension(ui: HeadlessUi): void {
  ui.setStatus("fixture", "Ready");
  ui.setWidget("fixture", ["line one", "line two"]);
  ui.setTitle("Fixture title");
  ui.setHeader(function fixtureHeader() { return undefined as never; });
  ui.setFooter(function fixtureFooter() { return undefined as never; });
}

function isBridged(envelope: BridgeEnvelope): boolean {
  const payload = envelope.payload;
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    && Object.hasOwn(payload, "__bridgedByBridgeExtension");
}

function recordedBridges(bus: FakeBus): BridgeEnvelope[] {
  const envelopes: BridgeEnvelope[] = [];
  bus.on(BRIDGE_MESSAGE_EVENT, (data) => envelopes.push(data as BridgeEnvelope));
  return envelopes;
}

test("an unchanged extension's ui.status event becomes an attributed protocol envelope", () => {
  const bus = fakeBus();
  bridgeExtension(fakePi(bus));
  const emitted = recordedBridges(bus);
  bus.emit(WEB_UI_EVENT, { sourceKey: "other.ext", type: "ui.status.changed", payload: { key: "x", text: "ready" } });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.name, "ui.status.changed");
  assert.deepEqual(emitted[0]?.source, { type: "extension", id: "other.ext" });
});

test("an unchanged ctx.ui fixture produces all five attributed bridged envelopes and views", () => {
  const bus = fakeBus();
  const disableBridge = bridgeExtension(fakePi(bus));
  const envelopes = recordedBridges(bus);
  unchangedFixtureExtension(createHeadlessWebUiContext({ events: bus, sourceId: "fixture.ext" }));

  const expected = {
    "ui.status.changed": "Status · fixture.ext: Ready",
    "ui.title.changed": "Title · fixture.ext: Fixture title",
    "ui.header.changed": "Header · fixture.ext: fixtureHeader",
    "ui.footer.changed": "Footer · fixture.ext: fixtureFooter",
  } as const;
  for (const [name, text] of Object.entries(expected)) {
    const matches = envelopes.filter((envelope) => envelope.name === name && isBridged(envelope));
    assert.equal(matches.length, 1, `one bridged ${name}`);
    assert.deepEqual(matches[0]?.source, { type: "extension", id: "fixture.ext" });
    const view = bridgedView(matches[0]!);
    assert.equal(view?.type, "status");
    assert.equal(view?.type === "status" ? view.text : "", text);
  }

  const widgets = envelopes.filter((envelope) => envelope.name === "ui.widget.changed" && isBridged(envelope));
  assert.equal(widgets.length, 1);
  assert.deepEqual(widgets[0]?.source, { type: "extension", id: "fixture.ext" });
  const widgetView = bridgedView(widgets[0]!);
  assert.equal(widgetView?.type, "list");
  assert.deepEqual(widgetView?.type === "list" ? widgetView.items : [], ["line one", "line two"]);
  assert.match(widgetView?.type === "list" ? String(widgetView.title) : "", /fixture\.ext.*fixture/);

  disableBridge();
  const count = envelopes.length;
  bus.emit(WEB_UI_EVENT, { sourceKey: "fixture.ext", type: "ui.status.changed", payload: { key: "fixture", text: "Again" } });
  assert.equal(envelopes.length, count);
});

test("the typed publisher adds header/footer/editor/autocomplete envelopes with the extension id", () => {
  const bus = fakeBus();
  bridgeExtension(fakePi(bus));
  const emitted = recordedBridges(bus);
  const publishers = [
    [publishUiHeader, "ui.header.changed"],
    [publishUiFooter, "ui.footer.changed"],
    [publishUiEditorComponent, "ui.editor-component.changed"],
    [publishUiAutocompleteProvider, "ui.autocomplete-provider.changed"],
  ] as const;
  for (const [publish, name] of publishers) {
    const result = publish({ events: bus }, "fixture.ext", "value", `opt-in:${name}`);
    assert.equal(result.ok, true);
    const original = emitted.find((envelope) => envelope.name === name && !isBridged(envelope));
    assert.deepEqual(original?.source, { type: "extension", id: "fixture.ext" });
    const bridged = emitted.find((envelope) => envelope.name === name && isBridged(envelope));
    assert.deepEqual(bridged?.source, { type: "extension", id: "fixture.ext" });
  }
});

test("headless editor and autocomplete calls no longer stay no-ops", () => {
  const bus = fakeBus();
  const ui = createHeadlessWebUiContext({ events: bus, sourceId: "fixture.ext" });
  const emitted = recordedBridges(bus);
  ui.setEditorComponent(function customEditor() { return undefined as never; });
  ui.addAutocompleteProvider(function customCompletions() { return (() => []) as never; });
  assert.deepEqual(emitted.map((envelope) => envelope.name).sort(), [
    "ui.autocomplete-provider.changed",
    "ui.editor-component.changed",
  ]);
  for (const envelope of emitted) {
    assert.deepEqual(envelope.source, { type: "extension", id: "fixture.ext" });
  }
});

test("publishWebUi events are not duplicated by the headless context", () => {
  const bus = fakeBus();
  bridgeExtension(fakePi(bus));
  const emitted = recordedBridges(bus);
  bus.emit(WEB_UI_EVENT, { sourceKey: "other.ext", type: "ui.title.changed", payload: { text: "Once" } });
  assert.equal(emitted.filter((envelope) => envelope.name === "ui.title.changed").length, 1);
});

test("disabling the bridge extension removes only its subscriptions", () => {
  const bus = fakeBus();
  const externalHandler = () => undefined;
  bus.on(WEB_UI_EVENT, externalHandler);
  const before = bus.handlers.get(WEB_UI_EVENT)?.length ?? 0;
  const disableBridge = bridgeExtension(fakePi(bus));
  assert.equal(bus.handlers.get(WEB_UI_EVENT)?.length, before + 1);
  disableBridge();
  const remaining = bus.handlers.get(WEB_UI_EVENT) ?? [];
  assert.equal(remaining.length, before);
  assert.ok(remaining.includes(externalHandler));
  const emitted = recordedBridges(bus);
  bus.emit(WEB_UI_EVENT, { sourceKey: "other.ext", type: "ui.status.changed", payload: { key: "x", text: "ready" } });
  assert.equal(emitted.length, 0);
  assert.equal(BRIDGE_EXTENSION_ID, "bridge");
  assert.equal(bridgedSurfaceId({ name: "ui.title.changed", source: { type: "extension", id: "fixture.ext" } } as never), "bridge:fixture.ext:ui.title.changed");
});
