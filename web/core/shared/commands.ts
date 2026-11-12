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

/** Commands whose name starts with the given prefix, best matches first. */
export function filterCommands(commands: readonly WebCommand[], prefix: string): WebCommand[] {
  const needle = prefix.toLowerCase();
  return commands
    .filter((command) => command.name.toLowerCase().startsWith(needle))
    .sort((a, b) => a.name.toLowerCase().indexOf(needle) - b.name.toLowerCase().indexOf(needle));
}
