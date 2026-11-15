/**
 * Extension-contributed web commands.
 *
 * The web's `web_command` channel runs a command in the pi process, on the
 * live session's context. The bridge owns its own built-ins (compact, fork,
 * tree, …); this contract is how *another* extension adds one without editing
 * the bridge.
 *
 * It is a two-way conversation on the session's event bus, because that is the
 * only channel that survives pi's extension loader: each extension is
 * evaluated with `moduleCache: false`, so two extensions never share a module
 * instance and a process-global registry would be read empty. So:
 *
 *   1. the contributor announces its commands (`WEB_PLUGIN_COMMANDS_EVENT`) —
 *      descriptors only, never a handler;
 *   2. the bridge lists them for the browser and, when one is dispatched,
 *      asks for it back (`WEB_PLUGIN_WEB_COMMAND_EVENT`), and the contributor
 *      that owns the name runs it.
 *
 * Both directions carry plain data, so a session, a `/reload`, or a second
 * frontend can never end up holding a stale function.
 */

/** Extension → bridge/host: "these are the web commands I contribute". */
export const WEB_PLUGIN_COMMANDS_EVENT = "web-plugin:commands";

/** Bridge/host → extension: "run this web command" (`{ name, args }`). */
export const WEB_PLUGIN_WEB_COMMAND_EVENT = "web-plugin:web-command";

/** One contributed command, as it travels: a name and its presentation flags. */
export interface WebCommandDescriptor {
  /** Dispatch name (`web_command.name`), unique across the session. */
  name: string;
  description: string;
  /**
   * This command manages the model catalogue, so the web's shared
   * model-settings dialog gives it a sidebar page (labelled by
   * `settingsEntry`). A presentation flag, not a capability: the command runs
   * exactly like any other.
   *
   * Several commands can say this — the provider editor and the router both
   * do — which is why it is *not* what picks the model picker's "+ Add
   * models" entry. That is `addsModels`.
   */
  managesModels?: boolean;
  /**
   * This command is what the model picker's "+ Add models" entry dispatches:
   * the one command that puts a model *into* the catalogue. Only meaningful
   * with `managesModels`, and only one command should claim it — a picker
   * entry that opens a page which cannot add a model is a dead end.
   */
  addsModels?: boolean;
  /**
   * The sidebar label this command gets inside the web's shared model-settings
   * dialog (the dialog with the Models / Provider / … nav). Only meaningful
   * with `managesModels`; the command name is the label when absent.
   */
  settingsEntry?: string;
  /** Publisher whose dialog is embedded in this settings page. */
  settingsPlugin?: string;
}

function isDescriptor(value: unknown): value is WebCommandDescriptor {
  if (value === null || typeof value !== "object") return false;
  const entry = value as {
    name?: unknown;
    description?: unknown;
    managesModels?: unknown;
    addsModels?: unknown;
    settingsEntry?: unknown;
    settingsPlugin?: unknown;
  };
  return typeof entry.name === "string"
    && entry.name !== ""
    && typeof entry.description === "string"
    && (entry.managesModels === undefined || typeof entry.managesModels === "boolean")
    && (entry.addsModels === undefined || typeof entry.addsModels === "boolean")
    && (entry.settingsEntry === undefined || typeof entry.settingsEntry === "string")
    && (entry.settingsPlugin === undefined || (typeof entry.settingsPlugin === "string" && entry.settingsPlugin !== ""));
}

/**
 * The commands in an announcement, or an empty list.
 *
 * The payload is untrusted like every other bus payload: a malformed entry is
 * dropped rather than failing the session.
 */
export function announcedCommandList(payload: unknown): WebCommandDescriptor[] {
  const commands = (payload as { commands?: unknown } | undefined)?.commands;
  if (!Array.isArray(commands)) return [];
  return commands.filter(isDescriptor);
}

/** The `{ name, args }` a dispatch request carries, or undefined when malformed. */
export function webCommandRequest(payload: unknown): { name: string; args: string } | undefined {
  const request = payload as { name?: unknown; args?: unknown } | undefined;
  if (typeof request?.name !== "string" || request.name === "") return undefined;
  return { name: request.name, args: typeof request.args === "string" ? request.args : "" };
}
