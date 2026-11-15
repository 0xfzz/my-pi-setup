// Slash commands for the web composer.
//
// pi owns the list: the command NAMES and DESCRIPTIONS come from pi's
// BUILTIN_SLASH_COMMANDS at runtime (never copied here) — the server merges
// them with the live session commands (the extension posts
// pi.getCommands() + the web core registry). This module owns only the
// web's PRESENTATION policy for those commands:
//
//   webPorted — the web answers it natively (a web dialog or action),
//               the TUI equivalent being a terminal dialog.
//   web       — dispatches through the web_command channel (the web core
//               registry inside pi), never as prompt text.
//   tuiOnly   — genuinely needs the terminal; the composer says so
//               instead of feeding it to the model.
//
// Anything unflagged dispatches as prompt text, like any pi session input.

export interface WebCommand {
  name: string;
  description?: string;
  /** Handled by the web client: opens a dialog or runs a web-side action. */
  webPorted?: boolean;
  /** Dispatches through the web core channel (web_command), not prompt text. */
  web?: boolean;
  /** TUI-only: rendered in the interactive transcript, not dispatchable from the web. */
  tuiOnly?: boolean;
  /**
   * The command manages the model catalogue, so the shared model-settings
   * dialog gives it a sidebar page. Set by the extension that registers the
   * command (it arrives on the session's `web_commands` list), never by this
   * policy table.
   */
  managesModels?: boolean;
  /**
   * The command is the model picker's "+ Add models" entry: the one that
   * puts a model into the catalogue. At most one command claims it, so a
   * second catalogue editor (the router) cannot take the picker's entry.
   */
  addsModels?: boolean;
  /**
   * The sidebar label this command gets inside the shared model-settings
   * dialog (the dialog with the Models / Provider / … nav). Only meaningful
   * with `managesModels`; defaults to the command name.
   */
  settingsEntry?: string;
  /** The plugin publisher rendered inside this settings page. */
  settingsPlugin?: string;
}

/** The web's presentation flags per built-in name — policy, not data. */
export const COMMAND_META: Readonly<Record<string, Omit<WebCommand, "name" | "description">>> = {
  settings: { webPorted: true },
  model: { webPorted: true },
  tree: { web: true },
  thinking: { webPorted: true },
  "scoped-models": { webPorted: true },
  export: { webPorted: true },
  import: { web: true },
  share: { web: true },
  bug: { web: true },
  copy: { webPorted: true },
  name: { web: true },
  session: { webPorted: true },
  changelog: { webPorted: true },
  hotkeys: { webPorted: true },
  fork: { web: true },
  clone: { web: true },
  trust: { webPorted: true },
  login: { webPorted: true },
  logout: { webPorted: true },
  new: { web: true },
  compact: { web: true },
  resume: { webPorted: true },
  reload: { web: true },
  quit: { web: true },
};

/**
 * Annotate pi's runtime built-in list (BUILTIN_SLASH_COMMANDS) with the
 * web's presentation flags. Unknown future commands pass through unflagged
 * — the web stays compatible with whatever pi ships.
 */
export function annotateBuiltinCommands(
  builtins: ReadonlyArray<{ name: string; description?: string; argumentHint?: string }>,
): WebCommand[] {
  return builtins.map((command) => ({
    name: command.name,
    ...(command.description !== undefined ? { description: command.description } : {}),
    ...COMMAND_META[command.name],
  }));
}

/** A command another extension contributed, with the flags it declared. */
export interface ContributedCommand {
  name: string;
  description?: string;
  managesModels?: boolean;
  addsModels?: boolean;
  settingsEntry?: string;
  settingsPlugin?: string;
}

/**
 * Merge contributed web commands into a session's command list.
 *
 * A pi command and a contributed web command can be the same thing — the
 * provider editor registers `/provider` with pi *and* declares it as a web
 * command, because the web's palette dispatches it through the `web_command`
 * channel rather than as prompt text. The contributed flags therefore land on
 * the existing entry instead of listing the command twice; a contributed
 * command pi does not know about is appended.
 */
export function annotateContributedCommands(
  commands: readonly WebCommand[],
  contributed: readonly ContributedCommand[],
): WebCommand[] {
  const flags = new Map(contributed.map((command) => [command.name, command]));
  const merged = commands.map((command) => {
    const declared = flags.get(command.name);
    if (declared === undefined) return command;
    flags.delete(command.name);
    return {
      ...command,
      web: true,
      ...modelSettingsFlags(declared),
    };
  });
  for (const declared of flags.values()) {
    merged.push({
      name: declared.name,
      ...(declared.description !== undefined ? { description: declared.description } : {}),
      web: true,
      ...modelSettingsFlags(declared),
    });
  }
  return merged;
}

/** The model-settings flags a contributed command declared, if any. */
function modelSettingsFlags(
  declared: ContributedCommand,
): Pick<WebCommand, "managesModels" | "addsModels" | "settingsEntry" | "settingsPlugin"> {
  if (declared.managesModels !== true) return {};
  return {
    managesModels: true,
    ...(declared.addsModels === true ? { addsModels: true } : {}),
    ...(declared.settingsEntry !== undefined ? { settingsEntry: declared.settingsEntry } : {}),
    ...(declared.settingsPlugin !== undefined ? { settingsPlugin: declared.settingsPlugin } : {}),
  };
}

/** Commands whose name starts with the given prefix, plus the given prefix. */
export function filterCommands(commands: readonly WebCommand[], prefix: string): WebCommand[] {
  const needle = prefix.toLowerCase();
  return commands
    .filter((command) => command.name.toLowerCase().startsWith(needle))
    .sort((a, b) => a.name.toLowerCase().indexOf(needle) - b.name.toLowerCase().indexOf(needle));
}
