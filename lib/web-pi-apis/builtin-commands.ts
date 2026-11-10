/**
 * `commands.builtin` — pi's own built-in slash command list.
 *
 * Loaded from pi's core module at runtime (never copied into the web), so
 * the web command palette and pi stay in sync across pi releases: whatever
 * commands pi ships, the web offers — names and descriptions included.
 */
import type { PiApiModule } from "./types.ts";

/** pi's BuiltinSlashCommand (the deep module's exported shape). */
export interface PiBuiltinCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

let builtins: readonly PiBuiltinCommand[] | null = null;

async function loadBuiltins(): Promise<readonly PiBuiltinCommand[]> {
  const { BUILTIN_SLASH_COMMANDS } = await import(
    "../../node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js"
  );
  return BUILTIN_SLASH_COMMANDS as readonly PiBuiltinCommand[];
}

/** pi's built-in commands (cached after the first load). */
export async function piBuiltinCommands(): Promise<readonly PiBuiltinCommand[]> {
  builtins ??= await loadBuiltins();
  return builtins;
}

export const builtinCommandsApi: PiApiModule = {
  api: "commands.builtin",

  async handle(): Promise<unknown> {
    return piBuiltinCommands();
  },
};
