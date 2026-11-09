// Slash commands for the web composer. Extension, prompt-template and skill
// commands come from the live session (the bridge posts
// pi.getCommands(); in-process sessions read the extension runner). The
// built-ins below mirror pi's BUILTIN_SLASH_COMMANDS: they are TUI
// commands — interactive selectors and dialogs — so the web lists them for
// discovery but tags them; the session only dispatches extension commands.

export interface WebCommand {
  name: string;
  description?: string;
  /** TUI-only: rendered in the interactive transcript, not dispatchable from the web. */
  tuiOnly?: boolean;
}

export const BUILTIN_COMMANDS: readonly WebCommand[] = [
  { name: "settings", description: "Open settings menu", tuiOnly: true },
  { name: "model", description: "Select model (opens selector UI)", tuiOnly: true },
  { name: "tree", description: "Navigate session tree (switch branches)", tuiOnly: true },
  { name: "thinking", description: "Set thinking level", tuiOnly: true },
  { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling", tuiOnly: true },
  { name: "export", description: "Export session (HTML default, or .html/.jsonl path)", tuiOnly: true },
  { name: "import", description: "Import a JSONL session, preserving its ID and cwd", tuiOnly: true },
  { name: "share", description: "Share session via a Radius artifact or a GitHub gist", tuiOnly: true },
  { name: "bug", description: "Report a bug to the Pi developers", tuiOnly: true },
  { name: "copy", description: "Copy last agent message to clipboard", tuiOnly: true },
  { name: "name", description: "Set session display name", tuiOnly: true },
  { name: "session", description: "Show session info and stats", tuiOnly: true },
  { name: "changelog", description: "Show changelog entries", tuiOnly: true },
  { name: "hotkeys", description: "Show all keyboard shortcuts", tuiOnly: true },
  { name: "fork", description: "Create a new fork from a previous user message", tuiOnly: true },
  { name: "clone", description: "Duplicate the current session at the current position", tuiOnly: true },
  { name: "trust", description: "Save project trust decision for future sessions", tuiOnly: true },
  { name: "login", description: "Configure provider authentication", tuiOnly: true },
  { name: "logout", description: "Remove provider authentication", tuiOnly: true },
  { name: "new", description: "Start a new session", tuiOnly: true },
  { name: "compact", description: "Manually compact the session context", tuiOnly: true },
  { name: "resume", description: "Resume another session", tuiOnly: true },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files", tuiOnly: true },
  { name: "quit", description: "Quit pi", tuiOnly: true },
];

/** Commands whose name starts with the given prefix, best matches first. */
export function filterCommands(commands: readonly WebCommand[], prefix: string): WebCommand[] {
  const needle = prefix.toLowerCase();
  return commands
    .filter((command) => command.name.toLowerCase().startsWith(needle))
    .sort((a, b) => a.name.toLowerCase().indexOf(needle) - b.name.toLowerCase().indexOf(needle));
}
