/**
 * Registry-driven, general-purpose system prompt.
 *
 * Pi already builds a structured prompt from the live tool registry, but two
 * limits matter here:
 *
 * - Its preamble is code-specific, so non-code sessions are addressed as a
 *   programmer.
 * - It lists a tool only if that tool declared a `promptSnippet`. A registered
 *   tool without one is invisible to the model even though it is callable.
 *
 * This extension fixes both by deriving the prompt from `getAllTools()`, so the
 * tool list is complete by construction and every rule is conditional on the
 * capability actually being present.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_DYNAMIC_PROMPT_CONFIG,
  buildDynamicSections,
  preserveDefaultSections,
  snippetFor,
  toolsMissingSnippets,
  validateConfig,
  visibleTools,
  type DynamicPromptConfig,
  type PromptTool,
} from "../lib/dynamic-prompt.ts";

const CONFIG_FILE = "dynamic-prompt.json";

/** The mutable prompt-options shape Pi hands to `before_agent_start`. */
interface PromptOptions {
  customPrompt?: string;
  toolSnippets?: Record<string, string>;
  sections?: Record<string, string>;
  selectedTools?: string[];
  hiddenTools?: string[];
  [key: string]: unknown;
}

/**
 * The tools this request can actually call.
 *
 * `getAllTools()` lists everything REGISTERED, including a tool a mode has
 * deactivated — Plan mode deactivates `write`/`edit`, and naming them would be
 * the same false-capability bug this extension exists to fix. The authoritative
 * loadout is `selectedTools` on the prompt options (which reflects
 * `setActiveTools()`); a non-array falls back to the registry so a caller that
 * has no loadout still gets a complete list.
 */
export function activeTools(tools: readonly PromptTool[], options: PromptOptions): PromptTool[] {
  const selected = options.selectedTools;
  if (!Array.isArray(selected)) return [...tools];
  const allowed = new Set(selected);
  const hidden = new Set(options.hiddenTools ?? []);
  return tools.filter((tool) => allowed.has(tool.name) && !hidden.has(tool.name));
}

/** Read this session's tool inventory. `getAllTools` is the only complete source. */
export function readTools(source: { getAllTools?: () => readonly any[] }): PromptTool[] {
  if (typeof source.getAllTools !== "function") return [];
  return source.getAllTools().map((tool: any) => ({
    name: tool.name,
    description: tool.description,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
    exposure: tool.exposure,
  }));
}

/**
 * Apply the configured prompt shape to Pi's options object, in place.
 *
 * Pure with respect to everything except `options`, so the same code paths serve
 * the live hook and the tests. `renderedPrompt` must be the prompt rendered
 * BEFORE this runs: `event.systemPrompt` re-renders the live options, so after
 * mutation it no longer shows the default sections being preserved.
 */
export function applyDynamicPrompt(
  options: PromptOptions,
  tools: readonly PromptTool[],
  config: DynamicPromptConfig,
  renderedPrompt = "",
): void {
  if (config.mode === "off") return;

  // Everything below describes the ACTIVE loadout only.
  const callable = activeTools(tools, options);

  // Close Pi's "no snippet, so not listed" gap. Harmless in replace mode (where
  // `sections.tools` wins) and load-bearing in append mode, which keeps Pi's list.
  const snippets: Record<string, string> = { ...options.toolSnippets };
  for (const tool of visibleTools(callable)) {
    if (!snippets[tool.name]) snippets[tool.name] = snippetFor(tool, config.maxSnippetChars);
  }
  options.toolSnippets = snippets;

  const sections = buildDynamicSections(callable, config);

  if (config.mode === "replace") {
    options.customPrompt = sections.preamble;
    // `customPrompt` suppresses Pi's tools/rules/docs, so re-supply all three.
    // `docs` is Pi's own static pointer: extract rather than duplicate it.
    const preserved = preserveDefaultSections(renderedPrompt);
    options.sections = {
      ...options.sections,
      tools: sections.tools,
      rules: sections.rules,
      capabilities: sections.capabilities,
      ...(preserved.docs ? { docs: preserved.docs } : {}),
    };
    return;
  }

  // Append: leave Pi's preamble and tool list alone, add only what is missing.
  options.sections = { ...options.sections, capabilities: sections.capabilities };
}

export default function dynamicPromptExtension(pi: ExtensionAPI) {
  const path = join(getAgentDir(), CONFIG_FILE);
  let active: DynamicPromptConfig = { ...DEFAULT_DYNAMIC_PROMPT_CONFIG };
  let configError: string | undefined;
  try {
    active = validateConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    // A missing file is the normal state; anything else is worth surfacing once.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") configError = String(error);
  }

  pi.on("session_start", (_event, ctx) => {
    if (configError && ctx.hasUI) {
      ctx.ui.notify(`dynamic-prompt: ignoring ${path} (${configError}). Using defaults.`, "warning");
    }
  });

  pi.on("before_agent_start", (event) => {
    if (active.mode === "off") return;
    applyDynamicPrompt(
      event.systemPromptOptions as unknown as PromptOptions,
      readTools(pi),
      active,
      event.systemPrompt,
    );
    // A forced prompt from another extension is opaque; nothing to contribute.
    return undefined;
  });

  async function handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
    const verb = (args ?? "").trim().toLowerCase();

    if (verb === "replace" || verb === "append" || verb === "off") {
      active = { ...active, mode: verb };
      ctx.ui.notify(`dynamic-prompt: mode ${verb} for this session (${path} sets the default).`, "info");
      return;
    }
    if (verb && verb !== "status") {
      ctx.ui.notify(`dynamic-prompt: unknown argument "${verb}". Use replace, append, off, or status.`, "warning");
      return;
    }

    const tools = readTools(pi);
    const visible = visibleTools(tools);
    const missing = toolsMissingSnippets(tools);
    // `getAllTools` is the registry; `getActiveTools` is this session's loadout.
    // Report both, because the prompt describes only the active ones.
    const activeNames = new Set(pi.getActiveTools());
    const callableCount = visible.filter((entry) => activeNames.has(entry.name)).length;
    const text = [
      `Mode: ${active.mode} (config: ${path})`,
      `Tools: ${callableCount} active of ${visible.length} registered` +
        (tools.length !== visible.length ? ` (${tools.length - visible.length} hidden)` : ""),
      missing.length
        ? `Pi's own tool list omits ${missing.length} tool(s) that declare no promptSnippet: ${missing.join(", ")}`
        : "Every visible tool declares a promptSnippet, so Pi's own list is already complete.",
      "",
      "Set for this session: /dynamic-prompt replace | append | off",
    ].join("\n");
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else console.log(text);
  }

  pi.registerCommand("dynamic-prompt", {
    description: "Show or set the registry-driven system prompt mode for this session (replace | append | off).",
    handler: handleCommand,
  });
}
