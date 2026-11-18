import test from "node:test";
import assert from "node:assert/strict";

import type { BridgeEnvelope } from "../web/core/protocol/envelope.ts";
import { validateView, VIEW_MAX_CELL_CHARS, VIEW_MAX_ROWS } from "../web/core/plugin-contracts/view.ts";
import { bridgedSurfaceId, bridgedView } from "../web/plugins/web-bridge/bridge-view.ts";

function envelope(name: string, payload: unknown, sourceId = "fixture.ext"): BridgeEnvelope {
  return {
    protocol: "pi-web-bridge",
    version: 1,
    kind: "event",
    name: name as BridgeEnvelope["name"],
    messageId: `${name}:1`,
    source: { type: "extension", id: sourceId },
    timestamp: 0,
    payload,
  };
}

const TEXT_SURFACES: Array<[string, unknown, string]> = [
  ["ui.status.changed", { key: "s", text: "Ready" }, "Status"],
  ["ui.widget.changed", { key: "w", lines: ["one", "two"], placement: "aboveEditor" }, "Widget"],
  ["ui.title.changed", { text: "A title" }, "Title"],
  ["ui.header.changed", { text: "A header" }, "Header"],
  ["ui.footer.changed", { text: "A footer" }, "Footer"],
];

test("all five required ctx.ui surfaces map to host-rendered declarative views", () => {
  for (const [name, payload, label] of TEXT_SURFACES) {
    const view = bridgedView(envelope(name, payload));
    assert.notEqual(view, undefined, `${name} has a view`);
    const validated = validateView(view);
    assert.equal(validated.ok, true, `${name} view passes host validation`);
    const rendered = JSON.stringify(view);
    assert.match(rendered, new RegExp(`${label} · fixture\\.ext`));
    assert.doesNotMatch(rendered, /"html"|"component"/, "no raw HTML or component factories");
  }
});

test("widget views carry bounded plain-text lines", () => {
  const view = bridgedView(envelope("ui.widget.changed", {
    key: "w",
    lines: Array.from({ length: VIEW_MAX_ROWS + 20 }, (_, index) => `line ${index}`),
    placement: "aboveEditor",
  }));
  assert.equal(view?.type, "list");
  assert.equal(view?.type === "list" ? view.items.length : 0, VIEW_MAX_ROWS);
  assert.equal(validateView(view).ok, true);
});

test("bridged text respects the host cell ceiling", () => {
  const view = bridgedView(envelope("ui.header.changed", { text: "x".repeat(VIEW_MAX_CELL_CHARS + 50) }));
  assert.equal(view?.type, "status");
  assert.ok((view?.type === "status" ? view.text.length : 0) <= VIEW_MAX_CELL_CHARS);
  assert.equal(validateView(view).ok, true);
});

test("unknown or empty surfaces produce no view", () => {
  assert.equal(bridgedView(envelope("models.changed", {})), undefined);
  assert.equal(bridgedView(envelope("ui.status.changed", { key: "s", text: null })), undefined);
  assert.equal(bridgedView(envelope("ui.widget.changed", { key: "w", lines: null, placement: "aboveEditor" })), undefined);
});

test("a bridged surface id is stable and source-scoped", () => {
  assert.equal(bridgedSurfaceId(envelope("ui.header.changed", { text: "x" })), "bridge:fixture.ext:ui.header.changed");
});
