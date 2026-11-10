/**
 * The default pi_api module set — the extension point for new web-facing
 * pi built-ins. Register a module here and the bridge, server and client
 * all see it through the shared api names; see docs/pi-web.md.
 */
import { autocompleteApi } from "./autocomplete.ts";
import { builtinCommandsApi } from "./builtin-commands.ts";
import type { PiApiModule } from "./types.ts";

export { createPiApiRegistry } from "./registry.ts";
export type { PiApiRegistry } from "./registry.ts";
export { piBuiltinCommands } from "./builtin-commands.ts";
export type { PiBuiltinCommand } from "./builtin-commands.ts";
export type { PiApiContext, PiApiModule } from "./types.ts";

/** Every api the web can call into pi — one entry per module. */
export const PI_API_MODULES: readonly PiApiModule[] = [autocompleteApi, builtinCommandsApi];
