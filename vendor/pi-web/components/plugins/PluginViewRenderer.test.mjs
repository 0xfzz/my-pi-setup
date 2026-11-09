import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { PluginViewRenderer, StatusIcon } = await jiti.import("./PluginViewRenderer.tsx");
const { actionKeybindingMatches, isEditableTarget } = await jiti.import("./actionClient.ts");

function toHtml(view) {
  return renderToStaticMarkup(React.createElement(PluginViewRenderer, { view }));
}

test("a plain string list renders exactly as before", () => {
  const html = toHtml({ type: "list", title: "Plain", items: ["alpha", "beta"] });
  assert.match(html, /plugin-view-list/);
  assert.match(html, /<li class="plugin-list-item">alpha<\/li>/);
  assert.match(html, /beta/);
});

test("rich list items render host status icons, not plugin glyphs", () => {
  const html = toHtml({
    type: "list",
    title: "Todo 1/2",
    items: [
      { text: "Port the icon renderer", status: "active" },
      { text: "Ship it", status: "done" },
    ],
  });
  assert.match(html, /plugin-list-item-rich/);
  assert.match(html, /plugin-item-icon-active/);
  assert.match(html, /plugin-item-icon-done/);
  // Icons are the host's stroke SVGs, not nerd-font codepoints the browser cannot show.
  assert.doesNotMatch(html, /[\u{f0000}-\u{fffff}]/u);
  assert.doesNotMatch(html, /\u25cf|\u2713/);
});

test("an item with detail renders a toggle whose markdown opens on demand", () => {
  const html = toHtml({
    type: "list",
    items: [
      { text: "Architecture spec", status: "done", detail: "## Why\nA **rendered** document." },
    ],
  });
  assert.match(html, /plugin-list-item-toggle/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /plugin-list-item-chevron/);
  // Closed by default: the markdown body is not in the initial markup.
  assert.doesNotMatch(html, /plugin-item-detail/);
});

test("plain rows never render a toggle or chevron", () => {
  const html = toHtml({ type: "list", items: ["one row"] });
  assert.doesNotMatch(html, /plugin-list-item-toggle/);
  assert.doesNotMatch(html, /plugin-list-item-chevron/);
});

test("a graph view renders a tree with kind chips, relations and omissions", () => {
  const html = toHtml({
    type: "graph",
    title: "Delegation",
    nodes: [
      { id: "parent", label: "Orchestrator", kind: "parent", status: "active" },
      { id: "child-1", label: "worker", kind: "child", status: "done", detail: "Milestone: landed" },
      { id: "child-2", label: "reviewer", kind: "review", status: "pending" },
    ],
    edges: [
      { from: "parent", to: "child-1", label: "handoff" },
      { from: "child-1", to: "child-2", label: "review" },
    ],
    omitted: 2,
  });
  assert.match(html, /plugin-view-graph/);
  assert.match(html, /data-node-id="parent"/);
  // A parent node's kind chip; the default child kind renders no chip.
  assert.match(html, /plugin-graph-kind-parent">parent/);
  assert.match(html, /plugin-graph-kind-review">review/);
  assert.doesNotMatch(html, /plugin-graph-kind-child/);
  // Edge labels show as relation prefixes on child rows.
  assert.match(html, /plugin-graph-relation-label">↳ handoff</);
  assert.match(html, /plugin-view-omitted/);
});

test("kv and status views keep their existing markup", () => {
  const kv = toHtml({ type: "kv", title: "Cache", rows: [{ label: "Last", value: "99% hit" }] });
  assert.match(kv, /plugin-kv-table/);
  assert.match(kv, /plugin-kv-label">Last/);
  const status = toHtml({ type: "status", tone: "warning", text: "Plan mode" });
  assert.match(status, /tone-warning/);
  assert.match(status, /Plan mode/);
});

test("StatusIcon covers the whole closed status vocabulary", () => {
  for (const status of ["pending", "active", "done", "blocked", "failed", "neutral"]) {
    const html = renderToStaticMarkup(React.createElement(StatusIcon, { status }));
    assert.match(html, new RegExp(`plugin-item-icon-${status}`), `${status} needs an icon`);
  }
});

test("action keybinding matching: modifiers, physical key, and typing guards", () => {
  const event = (over = {}) => ({
    key: "m", code: "KeyM", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...over,
  });
  assert.equal(actionKeybindingMatches("Alt+M", event()), true);
  assert.equal(actionKeybindingMatches("Alt+M", event({ altKey: false })), false);
  assert.equal(actionKeybindingMatches("Ctrl+Shift+P", event({ ctrlKey: true, altKey: false, shiftKey: true, key: "p" })), true);
  assert.equal(actionKeybindingMatches("Alt+M", event({ shiftKey: true })), false, "undeclared modifier");
  // A layout where the modifier types a character (Option+M is µ) still matches on code.
  assert.equal(actionKeybindingMatches("Alt+M", event({ key: "µ" })), true);
  // Letter and digit keys match; a different physical key does not.
  assert.equal(actionKeybindingMatches("Alt+M", event({ key: "n", code: "KeyN" })), false);
  assert.equal(actionKeybindingMatches("Ctrl+9", event({ ctrlKey: true, altKey: false, key: "9", code: "Digit9" })), true);

  // Plain Node has no DOM: a minimal HTMLElement stub is enough, because
  // isEditableTarget resolves the global at call time.
  class FakeHTMLElement {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.isContentEditable = false; }
  }
  globalThis.HTMLElement = FakeHTMLElement;
  const el = (tag, props = {}) => Object.assign(new FakeHTMLElement(tag), props);
  assert.equal(isEditableTarget(el("textarea")), true);
  assert.equal(isEditableTarget(el("input")), true);
  assert.equal(isEditableTarget(el("div")), false);
  assert.equal(isEditableTarget(null), false);
  assert.equal(isEditableTarget(Object.assign(el("div"), { isContentEditable: true })), true);
});
