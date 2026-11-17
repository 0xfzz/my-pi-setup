/**
 * The frozen message catalog. This table is the single source for the
 * generated docs/bridge-protocol-catalog.md and the conformance suite: every
 * wire name that exists today maps to exactly one protocol message.
 */
import { BRIDGE_PROTOCOL, BRIDGE_PROTOCOL_VERSION, HELLO, HELLO_ACK } from "./version.ts";

export const MESSAGE_KINDS = ["command", "query", "event", "capability"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface MessageDefinition {
  readonly name: string;
  readonly kind: MessageKind;
  readonly legacy: readonly string[];
  readonly description: string;
  /** Plugin-originated calls with no domain capability use protocol.invoke:<name>. */
  readonly capability?: string;
}

/** Generic gate for plugin-originated messages without a domain capability. */
export const PROTOCOL_INVOKE_CAPABILITY = "protocol.invoke";

export function protocolInvoke(name: string): string {
  return `${PROTOCOL_INVOKE_CAPABILITY}:${name}`;
}

const invoke = (name: string): string => protocolInvoke(name);
const publish = "ui.publish";

export const MESSAGE_CATALOG = [
  // Queries — read state or request a snapshot; never mutate pi.
  { name: "autocomplete.suggestions", kind: "query", legacy: ["autocomplete.suggestions"], capability: invoke("autocomplete.suggestions"), description: "Composer mention completions." },
  { name: "commands.builtin", kind: "query", legacy: ["commands.builtin"], capability: invoke("commands.builtin"), description: "pi's built-in slash commands." },
  { name: "settings.read", kind: "query", legacy: ["settings.read"], capability: invoke("settings.read"), description: "Current settings entries." },
  { name: "settings.models.read", kind: "query", legacy: ["settings.models.read"], capability: invoke("settings.models.read"), description: "Scoped model patterns." },
  { name: "trust.read", kind: "query", legacy: ["trust.read"], capability: invoke("trust.read"), description: "Project trust options and saved decision." },
  { name: "auth.read", kind: "query", legacy: ["auth.read"], capability: invoke("auth.read"), description: "Providers and stored credentials." },
  { name: "auth.state", kind: "query", legacy: ["auth.state"], capability: invoke("auth.state"), description: "State of one in-flight login." },
  { name: "mcp.read", kind: "query", legacy: ["mcp.read"], capability: invoke("mcp.read"), description: "Loaded MCP configuration." },
  { name: "ui.snapshot", kind: "query", legacy: ["ui_sync", "web-plugin:ui-sync"], capability: publish, description: "Re-emit the session's current UI surfaces." },
  { name: "session.resync", kind: "query", legacy: ["bridge_resync"], capability: "session.read", description: "Gap recovery from the last cursor." },
  { name: "plugin-state.snapshot", kind: "query", legacy: ["plugin_state"], capability: "session.read", description: "Current plugin state snapshot." },

  // Commands — may mutate pi after capability and confirmation revalidation.
  { name: "settings.write", kind: "command", legacy: ["settings.write"], capability: invoke("settings.write"), description: "Write one setting." },
  { name: "settings.models.write", kind: "command", legacy: ["settings.models.write"], capability: invoke("settings.models.write"), description: "Set scoped model patterns." },
  { name: "trust.write", kind: "command", legacy: ["trust.write"], capability: invoke("trust.write"), description: "Save a trust decision." },
  { name: "auth.login", kind: "command", legacy: ["auth.login"], capability: invoke("auth.login"), description: "Start a provider login." },
  { name: "auth.answer", kind: "command", legacy: ["auth.answer"], capability: invoke("auth.answer"), description: "Answer a login prompt." },
  { name: "auth.logout", kind: "command", legacy: ["auth.logout"], capability: invoke("auth.logout"), description: "Remove a provider credential." },
  { name: "mcp.write", kind: "command", legacy: ["mcp.write"], capability: invoke("mcp.write"), description: "Add, patch, override or remove an MCP server." },
  { name: "session.prompt", kind: "command", legacy: ["prompt"], capability: "session.write", description: "Send a user prompt to the live session." },
  { name: "session.abort", kind: "command", legacy: ["abort"], capability: "session.write", description: "Abort the current turn." },
  { name: "plugin.action.submit", kind: "command", legacy: ["action"], capability: invoke("plugin.action.submit"), description: "Submit a declared action with its confirm string." },
  { name: "session.set-model", kind: "command", legacy: ["set_model"], capability: "session.write", description: "Change the session model." },
  { name: "session.set-thinking", kind: "command", legacy: ["set_thinking"], capability: "session.write", description: "Change the thinking level." },
  { name: "web-command.dispatch", kind: "command", legacy: ["web_command"], capability: "commands", description: "Dispatch a built-in web command." },
  { name: "extension.web-command.dispatch", kind: "command", legacy: ["web-plugin:web-command"], capability: "commands", description: "Dispatch an extension-declared web command." },

  // Events — streams with per-(session, channel) sequence and a resume cursor.
  { name: "extension.commands.changed", kind: "event", legacy: ["web-plugin:commands"], capability: "events.subscribe:commands", description: "An extension changed its declared commands." },
  { name: "ui.working.changed", kind: "event", legacy: ["ui.working.changed"], capability: publish, description: "Working indicator changed." },
  { name: "ui.status.changed", kind: "event", legacy: ["ui.status.changed"], capability: publish, description: "Status key changed." },
  { name: "ui.widget.changed", kind: "event", legacy: ["ui.widget.changed"], capability: publish, description: "Widget lines changed." },
  { name: "ui.custom.changed", kind: "event", legacy: ["ui.custom.changed"], capability: publish, description: "Custom UI method changed." },
  { name: "ui.title.changed", kind: "event", legacy: ["ui.title.changed"], capability: publish, description: "Session title changed." },
  { name: "ui.editor.changed", kind: "event", legacy: ["ui.editor.changed"], capability: publish, description: "Editor text changed." },
  { name: "ui.view.changed", kind: "event", legacy: ["ui.view.changed", "web-plugin:view"], capability: publish, description: "A declared plugin view changed." },
  { name: "ui.layout.changed", kind: "event", legacy: ["ui.layout.changed"], capability: publish, description: "A plugin layout contribution changed." },
  { name: "ui.session.lifecycle", kind: "event", legacy: ["ui.session.lifecycle"], capability: publish, description: "Session running/closed state changed." },
  { name: "ui.plugin.action-requested", kind: "event", legacy: ["ui.plugin.action-requested", "web-plugin:action-request"], capability: publish, description: "A plugin asked the browser for an action." },
  { name: "ui.notify", kind: "event", legacy: ["ui.notify"], capability: publish, description: "Transient notification." },
  { name: "models.changed", kind: "event", legacy: ["web-plugin:models-changed"], capability: "events.subscribe:models", description: "The model catalogue changed." },
  { name: "tool.execution.changed", kind: "event", legacy: [], capability: "events.subscribe:tools", description: "A tool call started, updated or finished in another extension." },
  { name: "session.attach.attached", kind: "event", legacy: ["bridge_attached", "web_commands", "web_models", "web_tree"], capability: "session.read", description: "Session attach snapshot: commands, models and tree." },
  { name: "ui.header.changed", kind: "event", legacy: [], capability: publish, description: "setHeader surfaced through the bridge." },
  { name: "ui.footer.changed", kind: "event", legacy: [], capability: publish, description: "setFooter surfaced through the bridge." },
  { name: "ui.editor-component.changed", kind: "event", legacy: [], capability: publish, description: "setEditorComponent surfaced through the bridge." },
  { name: "ui.autocomplete-provider.changed", kind: "event", legacy: [], capability: publish, description: "addAutocompleteProvider surfaced through the bridge." },

  // Capability — handshake only; no pi state is touched.
  { name: HELLO, kind: "capability", legacy: [], description: "Client declares version, bindings and requested capabilities." },
  { name: HELLO_ACK, kind: "capability", legacy: [], description: "Host grants capabilities, session id and starting cursor." },
] as const satisfies readonly MessageDefinition[];

export type MessageName = (typeof MESSAGE_CATALOG)[number]["name"];

export const MESSAGE_NAMES: readonly MessageName[] = MESSAGE_CATALOG.map((message) => message.name);

export function lookupMessage(name: string): MessageDefinition | undefined {
  return MESSAGE_CATALOG.find((message) => message.name === name);
}

export function legacyWires(): readonly string[] {
  return MESSAGE_CATALOG.flatMap((message) => message.legacy);
}

function definitionRows(messages: readonly MessageDefinition[]): string {
  return messages.map((message) =>
    `| \`${message.name}\` | ${message.capability === undefined ? "core only" : `\`${message.capability}\``} | ${message.description} |`
  ).join("\n");
}

/** Generated markdown; the doc and this table can never drift silently. */
export function catalogMarkdown(): string {
  const sections = MESSAGE_KINDS.map((kind) => {
    const rows = definitionRows(MESSAGE_CATALOG.filter((message) => message.kind === kind));
    return `## ${kind}\n\n| Message | Required capability | Meaning |\n| --- | --- | --- |\n${rows}\n`;
  });
  const legacy = MESSAGE_CATALOG.filter((message) => message.legacy.length > 0).map((message) =>
    `| ${message.legacy.map((name) => `\`${name}\``).join(", ")} | \`${message.name}\` | ${message.kind} |`
  ).join("\n");
  return [
    "# Pi Web Bridge Protocol message catalog",
    "",
    "> Part of [pi-workflow-extensions](../README.md). Generated by `scripts/gen-bridge-protocol-catalog.mjs`. Do not edit by hand.",
    "",
    `Protocol \`${BRIDGE_PROTOCOL}\` v${BRIDGE_PROTOCOL_VERSION}. Every legacy wire name maps to one catalog message; aliases remain until Phase 7.`,
    "",
    ...sections,
    "## Legacy wire map\n",
    "| Today's wire | Protocol message | Kind |\n| --- | --- | --- |\n" + legacy,
    "",
  ].join("\n");
}
