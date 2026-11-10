/**
 * `autocomplete.suggestions` — pi's editor autocomplete, called natively.
 *
 * The web composer is one line of pi's multi-line editor; the module hands
 * that line to CombinedAutocompleteProvider (pi-tui) and returns whatever
 * pi itself would offer: @ file mentions, paths, and quoted paths, scored
 * by pi's fuzzy ranking and walked by fd (gitignore-aware, discovered via
 * pi's own ensureTool). The web never implements completion logic.
 *
 * The provider is bound to the session cwd; it is rebuilt when the cwd
 * changes (clone/fork into another directory) and dropped on dispose.
 */
import type { PiAutocompleteSuggestions } from "../../web/shared/pi-api.ts";
import type { PiApiContext, PiApiModule } from "./types.ts";

/** pi's public editor/autocomplete package. */
type Provider = {
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<PiAutocompleteSuggestions | null>;
};

/** pi's tool manager — locates (or downloads) fd exactly like the TUI does. */
type EnsureTool = (tool: "fd") => Promise<string | undefined>;

interface AutocompleteState {
  cwd: string;
  provider: Provider;
}

let state: AutocompleteState | null = null;

/** The dynamic import — both packages are declared dependencies. */
async function loadProvider(cwd: string, fdPath: string | null | undefined): Promise<Provider> {
  const { CombinedAutocompleteProvider } = await import("@earendil-works/pi-tui");
  return new CombinedAutocompleteProvider([], cwd, fdPath ?? null) as unknown as Provider;
}

async function loadEnsureTool(): Promise<EnsureTool> {
  // pi's package "exports" map only opens the main entry; the tool manager
  // is a deep module, so it loads by file path (pi's own code, no reimpl).
  const module = await import(
    "../../node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js"
  );
  return module.ensureTool as EnsureTool;
}

async function providerFor(ctx: PiApiContext): Promise<Provider> {
  if (state !== null && state.cwd === ctx.cwd) return state.provider;
  let fdPath: string | undefined;
  try {
    const ensureTool = await loadEnsureTool();
    fdPath = await ensureTool("fd");
  } catch {
    // Without fd the provider still serves directory-listing completions.
  }
  const provider = await loadProvider(ctx.cwd, fdPath);
  state = { cwd: ctx.cwd, provider };
  return provider;
}

export const autocompleteApi: PiApiModule = {
  api: "autocomplete.suggestions",

  async handle(params: unknown, ctx: PiApiContext): Promise<unknown> {
    const { line, cursorCol } = (
      params as { line?: unknown; cursorCol?: unknown } | null ?? {}
    ) as { line?: unknown; cursorCol?: unknown };
    if (typeof line !== "string" || typeof cursorCol !== "number") {
      throw new Error("params: {line: string, cursorCol: number}");
    }
    const provider = await providerFor(ctx);
    // The composer is a single-line editor: line 0, the caret column.
    return provider.getSuggestions([line], 0, cursorCol, { signal: ctx.signal });
  },

  dispose(): void {
    state = null;
  },
};
