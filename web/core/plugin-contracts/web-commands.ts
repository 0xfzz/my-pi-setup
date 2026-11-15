/**
 * Extension-contributed web commands.
 *
 * The web's `web_command` channel runs a command in the pi process, with the
 * live session's context. The bridge owns its own built-ins (compact, fork,
 * tree, …); this registry is how *another* extension adds one without editing
 * the bridge: it registers the entry next to the code that implements it, and
 * the bridge lists and dispatches it like any other.
 *
 * A registered command is always "direct": it runs on the session's extension
 * context, never through pi's command runner. An extension that needs the
 * runner registers a real pi command instead.
 */

/** One web command an extension contributes. */
export interface WebCommandEntry<TContext> {
  /** Dispatch name (`web_command.name`), unique across the registry. */
  name: string;
  description: string;
  /**
   * This command manages the model catalogue, so the web's model picker
   * offers it as its "add models" entry. A presentation flag, not a
   * capability: the command runs exactly like any other.
   */
  managesModels?: boolean;
  handler: (args: string, ctx: TContext) => void | Promise<void>;
}

/**
 * Handlers are stored with their context type erased: the registry's contract
 * is that the dispatcher passes the context the registrant declared, so the
 * cast is the registry's own promise, made once here rather than at every
 * call site.
 */
const entries: Array<WebCommandEntry<unknown>> = [];

export function registerWebCommand<TContext>(entry: WebCommandEntry<TContext>): void {
  const existing = entries.findIndex((candidate) => candidate.name === entry.name);
  const erased = entry as WebCommandEntry<unknown>;
  if (existing >= 0) entries[existing] = erased;
  else entries.push(erased);
}

/** Every registered command, in registration order. */
export function registeredWebCommands(): ReadonlyArray<WebCommandEntry<unknown>> {
  return [...entries];
}

/** The command with this name, or undefined. */
export function registeredWebCommand(name: string): WebCommandEntry<unknown> | undefined {
  return entries.find((entry) => entry.name === name);
}

/** Test seam: drop every registration. */
export function clearWebCommands(): void {
  entries.length = 0;
}
