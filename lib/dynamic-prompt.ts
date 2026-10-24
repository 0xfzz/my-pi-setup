/**
 * General-purpose, registry-driven system prompt.
 *
 * Two problems this solves, both the same underlying failure mode:
 *
 * 1. Pi's default preamble is code-specific ("an expert coding assistant ...
 *    editing code"), so a session whose work is research, writing, data analysis
 *    or operations is addressed as a programmer.
 * 2. Pi lists a tool in `<tools>` ONLY if the tool declared a `promptSnippet`.
 *    Every tool that does not is invisible to the model even though it is
 *    registered and callable — the model cannot use what it is not told about.
 *
 * Everything here is derived from the live tool registry at request time, so the
 * prompt cannot name a capability the session does not have. That is the same
 * invariant `lib/plan-mode.ts` broke when its allowlist named MCP resource tools
 * that are only registered when a server advertises resources.
 */

export type PromptMode = "replace" | "append" | "off";

export interface PromptTool {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  exposure?: string;
}

export interface DynamicPromptConfig {
  /** `replace` rewrites the preamble; `append` keeps Pi's and adds sections. */
  mode: PromptMode;
  /** Snippets are cut here so one verbose description cannot dominate the list. */
  maxSnippetChars: number;
  /** Include each tool's own promptGuidelines bullets. */
  includeToolGuidelines: boolean;
}

export const DEFAULT_DYNAMIC_PROMPT_CONFIG: DynamicPromptConfig = {
  mode: "replace",
  maxSnippetChars: 110,
  includeToolGuidelines: true,
};

/** Validate untrusted config, falling back per-field rather than rejecting wholesale. */
export function validateConfig(value: unknown): DynamicPromptConfig {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const mode = raw.mode === "replace" || raw.mode === "append" || raw.mode === "off"
    ? raw.mode
    : DEFAULT_DYNAMIC_PROMPT_CONFIG.mode;
  const maxSnippetChars = typeof raw.maxSnippetChars === "number" && Number.isFinite(raw.maxSnippetChars)
    ? Math.min(400, Math.max(40, Math.floor(raw.maxSnippetChars)))
    : DEFAULT_DYNAMIC_PROMPT_CONFIG.maxSnippetChars;
  const includeToolGuidelines = typeof raw.includeToolGuidelines === "boolean"
    ? raw.includeToolGuidelines
    : DEFAULT_DYNAMIC_PROMPT_CONFIG.includeToolGuidelines;
  return { mode, maxSnippetChars, includeToolGuidelines };
}

/** Tools the model can actually see. Hidden tools are reachable only via another tool. */
export function visibleTools(tools: readonly PromptTool[]): PromptTool[] {
  return tools.filter((tool) => tool.exposure !== "hidden").sort((a, b) => a.name.localeCompare(b.name));
}

/** First sentence of a description, trimmed of leading Markdown and hard-wrapped noise. */
function firstSentence(description: string | undefined): string {
  if (!description) return "";
  const flat = description.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  // A sentence ends at punctuation followed by a space or the end of the string.
  const match = flat.match(/^(.*?[.!?])(?:\s|$)/);
  return (match ? match[1] : flat).trim();
}

/**
 * A one-line snippet for a tool, shortening rather than omitting.
 *
 * Pi drops tools without a snippet entirely, so returning `""` here would hide a
 * registered tool. The name itself is always a usable fallback.
 */
export function snippetFor(tool: PromptTool, maxChars: number): string {
  const declared = tool.promptSnippet?.replace(/\s+/g, " ").trim();
  const text = declared || firstSentence(tool.description) || tool.name.replace(/[_-]+/g, " ");
  if (text.length <= maxChars) return text;
  // Cut on a word boundary; the ellipsis marks that the text was shortened.
  const clipped = text.slice(0, maxChars);
  const boundary = clipped.lastIndexOf(" ");
  return `${(boundary > maxChars * 0.6 ? clipped.slice(0, boundary) : clipped).replace(/[,;:]$/, "")}…`;
}

export interface ToolFamily {
  /** Stable key used for grouping and for the rendered heading. */
  key: string;
  label: string;
  tools: PromptTool[];
}

/** `mcp__<server>__<tool>` → the server name, so one server's tools stay together. */
function mcpServerOf(name: string): string | undefined {
  const match = name.match(/^mcp__([^_]+)__/);
  return match?.[1];
}

/**
 * Group tools into families by shared name prefix.
 *
 * Data-driven on purpose: a family exists when at least two tools share the
 * leading token, so tools this package has never heard of (an MCP server, a new
 * extension) group themselves instead of falling into a hardcoded list.
 */
export function groupTools(tools: readonly PromptTool[]): ToolFamily[] {
  const families = new Map<string, { label: string; tools: PromptTool[] }>();
  const singles: PromptTool[] = [];

  const byToken = new Map<string, PromptTool[]>();
  const byServer = new Map<string, PromptTool[]>();
  for (const tool of tools) {
    const server = mcpServerOf(tool.name);
    if (server) {
      const bucket = byServer.get(server) ?? [];
      bucket.push(tool);
      byServer.set(server, bucket);
      continue;
    }
    const token = tool.name.split(/[_-]/)[0];
    const bucket = byToken.get(token) ?? [];
    bucket.push(tool);
    byToken.set(token, bucket);
  }

  for (const [server, bucket] of byServer) {
    families.set(`mcp:${server}`, { label: `${server} (MCP)`, tools: bucket });
  }
  for (const [token, bucket] of byToken) {
    // A lone tool is its own capability, not a "family" of one.
    if (bucket.length < 2) { singles.push(...bucket); continue; }
    families.set(token, { label: token.charAt(0).toUpperCase() + token.slice(1), tools: bucket });
  }
  if (singles.length) families.set("other", { label: "Other tools", tools: singles });

  return [...families.entries()]
    .map(([key, value]) => ({ key, ...value, tools: [...value.tools].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => b.tools.length - a.tools.length || a.label.localeCompare(b.label));
}

/** The complete tool inventory, one line per tool. Never omits a visible tool. */
export function renderToolList(tools: readonly PromptTool[], maxChars: number): string {
  const families = groupTools(visibleTools(tools));
  if (!families.length) return "(no tools are registered)";
  return families.map((family) => {
    const lines = family.tools.map((tool) => `- ${tool.name}: ${snippetFor(tool, maxChars)}`);
    return [`### ${family.label}`, ...lines].join("\n");
  }).join("\n\n");
}

/** Names of tools the session actually has, as a set. */
function names(tools: readonly PromptTool[]): Set<string> {
  return new Set(tools.map((tool) => tool.name));
}

/**
 * Factual statements about the session's capabilities.
 *
 * Facts, not instructions: this tells the model what exists so it does not offer
 * to do something it cannot, and does not stay silent about something it can.
 */
export function capabilityFacts(tools: readonly PromptTool[]): string[] {
  const present = names(visibleTools(tools));
  const facts: string[] = [];
  if (present.size) facts.push(`${present.size} tools are registered and callable in this session.`);
  const servers = new Set([...present].map(mcpServerOf).filter((server): server is string => Boolean(server)));
  if (servers.size) facts.push(`MCP servers connected: ${[...servers].sort().join(", ")}.`);
  if ([...present].some((name) => /^(read|grep|find|ls|ffgrep|fffind)$/.test(name))) {
    facts.push("The local filesystem is readable.");
  }
  if ([...present].some((name) => /^(edit|write)$/.test(name))) facts.push("Files can be modified.");
  if ([...present].some((name) => /^(bash|powershell)$/.test(name))) {
    facts.push("Commands can be executed on this machine.");
  }
  if ([...present].some((name) => /search|fetch|source_check/i.test(name))) {
    facts.push("The web can be searched or fetched from.");
  }
  if ([...present].some((name) => /^subagent|^subagents_/.test(name))) {
    facts.push("Work can be delegated to sub-agents running in parallel.");
  }
  if ([...present].some((name) => /^ask_user$/.test(name))) facts.push("The user can be asked a blocking question.");
  if ([...present].some((name) => /^browser/.test(name))) facts.push("A persistent browser can be driven.");
  if ([...present].some((name) => /^generate_image$/.test(name))) facts.push("Images can be generated.");
  return facts;
}

/**
 * Guidance derived from which tools exist.
 *
 * Every bullet is conditional on the capability being present, so the prompt
 * never instructs the model to use a tool the session does not have — the exact
 * bug class that produced the Plan-mode warning.
 */
export function derivedRules(tools: readonly PromptTool[], options: { includeToolGuidelines?: boolean } = {}): string[] {
  const visible = visibleTools(tools);
  const present = names(visible);
  const has = (pattern: RegExp) => [...present].some((name) => pattern.test(name));
  const rules: string[] = [];

  if (has(/^read$/)) {
    rules.push("Read a file before changing it; do not guess at contents you have not seen.");
  }
  if (has(/^(edit|write)$/) && has(/^read$/)) {
    rules.push("Prefer the smallest edit that does the job; re-read rather than rewriting a whole file from memory.");
  }
  if (has(/^(grep|ffgrep)$/)) rules.push("Search with grep instead of reading whole files when you only need one definition or string.");
  if (has(/^(find|fffind|ls)$/)) rules.push("Use find/ls to locate files by name; do not assume a path exists.");
  if (has(/^(bash|powershell)$/)) {
    rules.push("Verify with commands where possible, and say what you ran when the result matters.");
  }
  if (has(/search|fetch|source_check/i)) {
    rules.push("When a fact could have changed since your training, look it up rather than answering from memory.");
  }
  if (has(/^ask_user$/)) {
    rules.push("Ask only when a decision is genuinely the user's to make or required information is unavailable; otherwise use your judgement.");
  }
  if (has(/^subagent/)) {
    rules.push("Delegate self-contained work to sub-agents instead of doing everything serially when it is safe to parallelize.");
  }
  if (has(/^todo_(plan|act|next)$/)) {
    rules.push("Track multi-step work with todo_plan/todo_act; skip todos entirely for work you can finish in one step.");
  }
  if (has(/^browser/)) {
    rules.push("Verify web interactions against what the page visibly shows, not what you expect it to show.");
  }
  if (has(/^artifact_/)) {
    rules.push("Keep long specs and scratch notes in artifacts rather than in the conversation.");
  }
  rules.push("Prefer doing the task to describing how the user could do it, unless they asked for instructions.");
  rules.push("State uncertainty plainly instead of presenting a guess as a fact.");

  // On unless explicitly disabled: a tool's own bullets are the most specific
  // guidance available, so silently dropping them is the worse default.
  if (options.includeToolGuidelines !== false) {
    for (const tool of visible) {
      for (const guideline of tool.promptGuidelines ?? []) {
        const line = guideline.replace(/\s+/g, " ").trim();
        // A tool's own bullets are the most specific guidance available.
        if (line) rules.push(line);
      }
    }
  }
  return [...new Set(rules)];
}

/** The replacement preamble. Deliberately task-agnostic, and honest about scope. */
export function generalPreamble(toolCount: number): string {
  return [
    "You are an agent operating inside pi, a tool-using assistant harness.",
    "You help with whatever the user actually needs: software work, research, writing, analysis, planning, operations, or anything else. Do not assume every request is about code.",
    "You act by calling the tools available to you, and you can only act through them. When a tool is needed, call it instead of describing the call.",
    toolCount
      ? `Exactly ${toolCount} tool${toolCount === 1 ? " is" : "s are"} registered for this session, listed below; treat that list as authoritative and do not claim capabilities outside it.`
      : "No tools are registered in this session, so work from the conversation alone and say what you would need to act.",
  ].join(" ");
}

export interface DynamicPromptSections {
  preamble: string;
  tools: string;
  rules: string;
  capabilities: string;
}

/**
 * Build the sections this extension contributes.
 *
 * `docs` is deliberately absent: Pi's own docs section is preserved by the
 * extension (see `preserveDefaultSections`), because answering questions about
 * pi itself still needs it.
 */
export function buildDynamicSections(
  tools: readonly PromptTool[],
  config: DynamicPromptConfig,
): DynamicPromptSections {
  const visible = visibleTools(tools);
  const facts = capabilityFacts(visible);
  return {
    preamble: generalPreamble(visible.length),
    tools: renderToolList(visible, config.maxSnippetChars),
    rules: derivedRules(visible, { includeToolGuidelines: config.includeToolGuidelines })
      .map((rule) => `- ${rule}`).join("\n"),
    capabilities: facts.map((fact) => `- ${fact}`).join("\n") || "- No tools are registered.",
  };
}

/**
 * Pull Pi's default `<docs>` section out of a rendered prompt.
 *
 * `customPrompt` suppresses the default `tools`, `rules` and `docs` sections, and
 * the docs section is a static pointer to pi's own documentation — regenerating
 * it here would duplicate that. Extracting the rendered value keeps it in step
 * with whatever pi version is installed.
 */
export function preserveDefaultSections(renderedPrompt: string): { docs?: string } {
  const match = renderedPrompt.match(/<docs>\n([\s\S]*?)\n<\/docs>/);
  return match ? { docs: match[1] } : {};
}

/** Tools that Pi will omit from its own list because they declared no snippet. */
export function toolsMissingSnippets(tools: readonly PromptTool[]): string[] {
  return visibleTools(tools)
    .filter((tool) => !tool.promptSnippet?.trim())
    .map((tool) => tool.name);
}
