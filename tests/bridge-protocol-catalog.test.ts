import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  legacyWires,
  lookupMessage,
  MESSAGE_CATALOG,
  MESSAGE_KINDS,
  MESSAGE_NAMES,
  protocolInvoke,
  PROTOCOL_INVOKE_CAPABILITY,
  catalogMarkdown,
  type MessageDefinition,
} from "../web/core/protocol/catalog.ts";
import { BROWSER_ENTRY, isAllowedBrowserEntry } from "../web/core/protocol/manifest-extension.ts";
import { HELLO, HELLO_ACK } from "../web/core/protocol/version.ts";

/** Every wire name the seam inventory (plan §2) found. */
const EXISTING_WIRES = [
  "autocomplete.suggestions", "commands.builtin", "settings.read", "settings.write",
  "settings.models.read", "settings.models.write", "trust.read", "trust.write",
  "auth.read", "auth.login", "auth.state", "auth.answer", "auth.logout",
  "mcp.read", "mcp.write", "prompt", "abort", "action", "set_model", "set_thinking",
  "web_command", "ui_sync", "web-plugin:ui-sync", "bridge_resync",
  "web-plugin:commands", "web-plugin:web-command", "web-ui:event",
  "ui.working.changed", "ui.status.changed", "ui.widget.changed", "ui.custom.changed",
  "ui.title.changed", "ui.editor.changed", "ui.view.changed", "ui.layout.changed",
  "ui.session.lifecycle", "ui.plugin.action-requested", "ui.notify",
  "web-plugin:view", "plugin_state", "web-plugin:action-request",
  "web-plugin:models-changed", "web_commands", "web_models", "web_tree", "bridge_attached",
];

test("every catalogued message has a unique name and a known kind", () => {
  assert.equal(new Set(MESSAGE_NAMES).size, MESSAGE_NAMES.length);
  for (const message of MESSAGE_CATALOG) {
    assert.ok(MESSAGE_KINDS.includes(message.kind), `${message.name}: ${message.kind}`);
  }
});

test("every seam wire maps to a catalog message, exactly once", () => {
  const wires = legacyWires();
  assert.equal(new Set(wires).size, wires.length, "duplicate legacy wire");
  for (const wire of EXISTING_WIRES) {
    if (wire === "web-ui:event") continue; // the transport wrapper, not a message name
    assert.ok(wires.includes(wire), `${wire} has no protocol message`);
  }
});

test("handshake and no-op ctx.ui surfaces are in the catalog", () => {
  for (const name of [HELLO, HELLO_ACK, "ui.header.changed", "ui.footer.changed",
    "ui.editor-component.changed", "ui.autocomplete-provider.changed"]) {
    assert.ok(lookupMessage(name), name);
  }
});

test("plugin-originated capabilities keep the kind[:argument] grammar", () => {
  const definitions: readonly MessageDefinition[] = MESSAGE_CATALOG;
  const capabilities = definitions.flatMap((message) =>
    message.capability === undefined ? [] : [message.capability]);
  for (const capability of capabilities) {
    assert.ok(capability === "ui.publish" || capability === "commands"
      || capability === "session.read" || capability === "session.write"
      || capability.startsWith("events.subscribe:")
      || capability.startsWith(`${PROTOCOL_INVOKE_CAPABILITY}:`), capability);
  }
  assert.equal(protocolInvoke("session.prompt"), "protocol.invoke:session.prompt");
});

test("a browser half is trusted-only and stays inside the plugin directory", () => {
  assert.equal(BROWSER_ENTRY, "main.browser");
  assert.equal(isAllowedBrowserEntry("trusted", "./browser/main.tsx"), true);
  assert.equal(isAllowedBrowserEntry("declarative", "./browser/main.tsx"), false);
  assert.equal(isAllowedBrowserEntry("trusted", "../elsewhere/main.tsx"), false);
});

test("the generated catalog doc matches the source table", () => {
  assert.equal(readFileSync("docs/bridge-protocol-catalog.md", "utf8"), catalogMarkdown());
});
