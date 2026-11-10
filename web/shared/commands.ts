// Slash commands for the web composer. Extension, prompt-template and skill
// commands come from the live session (the bridge posts
// pi.getCommands(); in-process sessions read the extension runner). The
// built-ins below mirror pi's BUILTIN_SLASH_COMMANDS. `webPorted` commands
// run as native web dialogs/actions in the composer (the TUI dialog port:
// /model opens the web picker); `tuiOnly` ones genuinely need the terminal
// and the composer says so instead of feeding them to the model.

export interface WebCommand {
  name: string;
  description?: string;
  /** Handled by the web client: opens a dialog or runs a web-side action. */
  webPorted?: boolean;
  /** TUI-only: rendered in the interactive transcript, not dispatchable from the web. */
  tuiOnly?: boolean;
}

export const BUILTIN_COMMANDS: readonly WebCommand[] = [
  { name: "settings", description: "Open settings menu", tuiOnly: true },
  { name: "model", description: "Select model — opens the web picker", webPorted: true },
  { name: "tree", description: "Navigate session tree (switch branches)", tuiOnly: true },
  { name: "thinking", description: "Set thinking level — opens the web picker", webPorted: true },
  { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling", tuiOnly: true },
  { name: "export", description: "Export the transcript (markdown download)", webPorted: true },
  { name: "import", description: "Import a JSONL session, preserving its ID and cwd", tuiOnly: true },
  { name: "share", description: "Share session via a Radius artifact or a GitHub gist", tuiOnly: true },
  { name: "bug", description: "Report a bug to the Pi developers", tuiOnly: true },
  { name: "copy", description: "Copy last agent message to clipboard", webPorted: true },
  { name: "name", description: "Set session display name" },
  { name: "session", description: "Show session info and stats — web dialog", webPorted: true },
  { name: "changelog", description: "Show changelog entries — web dialog", webPorted: true },
  { name: "hotkeys", description: "Show all keyboard shortcuts", tuiOnly: true },
  { name: "fork", description: "Create a new fork from a previous user message", tuiOnly: true },
  { name: "clone", description: "Duplicate the current session at the current position" },
  { name: "trust", description: "Save project trust decision for future sessions", tuiOnly: true },
  { name: "login", description: "Configure provider authentication", tuiOnly: true },
  { name: "logout", description: "Remove provider authentication", tuiOnly: true },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Manually compact the session context" },
  { name: "resume", description: "Resume another session — opens the session list", webPorted: true },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
  { name: "quit", description: "Quit pi", tuiOnly: true },
];

/** Commands whose name starts with the given prefix, best matches first. */
export function filterCommands(commands: readonly WebCommand[], prefix: string): WebCommand[] {
  const needle = prefix.toLowerCase();
  return commands
    .filter((command) => command.name.toLowerCase().startsWith(needle))
    .sort((a, b) => a.name.toLowerCase().indexOf(needle) - b.name.toLowerCase().indexOf(needle));
}
