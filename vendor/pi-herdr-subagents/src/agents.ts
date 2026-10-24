// Agent-definition parsing, discovery, and launch-behavior resolution.
//
// Ported near-verbatim from pi-interactive-subagents (MIT, HazAT)
// pi-extension/subagents/index.ts @ fix/launch-verify-retry — this module is the
// frontmatter compatibility contract (PROJECT-BRIEF.md hard requirement 2): both
// extensions read the same ~/.pi/agent/agents/*.md files during the transition
// period, so field semantics must match exactly. Read-only consumption; the regex
// line parser is intentionally kept (compat trumps elegance — no YAML lib).
//
// Adaptations vs the reference:
// - No bundled `package` source in runtime discovery; package templates must be copied into
//   user-owned config explicitly with /subagents-init.
// - Params typed as a plain interface instead of the extension's typebox schema.
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * `standalone` = fresh child with a self-contained ticket (the default).
 * `digest` = fresh child plus a zero-LLM parent brief; `lineage-only` is the
 * legacy frontmatter spelling, accepted and mapped to `digest` so existing agent
 * definitions keep working without silently behaving like a fork.
 * `fork` = a full copy of the parent's active branch.
 */
export type SubagentSessionMode = "standalone" | "digest" | "lineage-only" | "fork";

/** The subset of `subagent` tool params that agent-def resolution consults. */
export interface SubagentSpawnParams {
  name: string;
  task: string;
  agent?: string;
  cwd?: string;
  fork?: boolean;
  interactive?: boolean;
}

export interface AgentDefaults {
  /**
   * Frontmatter `model:`. Use the provider/id form, e.g. `anthropic/claude-opus-5-5`. A bare id
   * combined with the agent's thinking level is fuzzy-matched by pi and can resolve to an
   * unconfigured provider.
   */
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  /**
   * Frontmatter `max-depth`: how deep a delegation chain may go beneath this
   * agent. A chain at this depth may not spawn again. Defaults to
   * `DEFAULT_MAX_DEPTH`; `PI_SUBAGENT_MAX_DEPTH` overrides for a run.
   */
  maxDepth?: number;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

export type AgentSource = "global" | "project";

export interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

export interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/** Tools that are gated by `spawning: false` */
export const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagent_interrupt",
  "subagents_list",
  "subagent_resume",
]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
export function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

function parseOptionalCount(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "digest" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

export function parseAgentDefinition(
  content: string,
  fallbackName: string,
): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
    spawning: parseOptionalBoolean(getFrontmatterValue(frontmatter, "spawning")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    maxDepth: parseOptionalCount(getFrontmatterValue(frontmatter, "max-depth")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

export function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }

  return [...agents.values()];
}

export function resolveSubagentPaths(
  params: SubagentSpawnParams,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

export function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

export function resolveEffectiveSessionMode(
  params: SubagentSpawnParams,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

export function resolveLaunchBehavior(
  params: SubagentSpawnParams,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "digest" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  // `lineage-only` never carried content; it is now the digest seed.
  const seededSessionMode = sessionMode === "standalone"
    ? null
    : sessionMode === "fork" ? "fork" : "digest";
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` tool parameter wins.
 *   2. Explicit `interactive` frontmatter field on the agent.
 *   3. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, worker, reviewer) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (planner, iterate/fork) and
 *      stall pings are noise.
 *
 * Bare spawns and profiles without lifecycle settings are autonomous by
 * default. Long-running user-driven sessions must explicitly set interactive:
 * true (or auto-exit: false). Forking context does not imply staying open.
 */
export function resolveEffectiveInteractive(
  params: SubagentSpawnParams,
  agentDefs: AgentDefaults | null,
): boolean {
  if (params.interactive != null) return params.interactive;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? true);
}

/** Delegation depth beyond which spawning is refused when nothing overrides it. */
export const DEFAULT_MAX_DEPTH = 2;

/**
 * How many delegation hops above this process, from `PI_SUBAGENT_DEPTH`.
 *
 * The launch script exports the parent's depth + 1, so the top-level session is
 * depth 0 and its children are depth 1. An unparsable value reads as 0 (a
 * malformed env var must not silently disable the cap).
 */
export function currentSubagentDepth(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number.parseInt(env.PI_SUBAGENT_DEPTH ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** Frontmatter `max-depth`, then `PI_SUBAGENT_MAX_DEPTH`, then the default. */
export function maxSubagentDepth(
  agentDefs: AgentDefaults | null,
  env: Record<string, string | undefined> = process.env,
): number {
  if (typeof agentDefs?.maxDepth === "number" && Number.isFinite(agentDefs.maxDepth)) {
    return agentDefs.maxDepth;
  }
  return parseOptionalCount(env.PI_SUBAGENT_MAX_DEPTH) ?? DEFAULT_MAX_DEPTH;
}

/**
 * Why this spawn is refused, or `null` when it is allowed.
 *
 * Two independent limits, both checked before any artifact is written or pane
 * started:
 *
 * - **Depth cap** — a chain already `max-depth` hops deep may not spawn again.
 * - **Fork chain cap** — a fork child at depth >= 1 may not fork again. Forking
 *   compounds: each generation re-reads a whole parent branch, so a fork of a
 *   fork multiplies context cost. A `digest` grandchild is cheap and allowed.
 *
 * Checked here rather than by denying tools, because the fork rule depends on
 * the requested mode: denying `subagent` outright would also forbid the cheap
 * digest grandchildren the cap is meant to steer callers toward.
 */
export function resolveDepthDenial(
  params: SubagentSpawnParams,
  agentDefs: AgentDefaults | null,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const depth = currentSubagentDepth(env);
  const maxDepth = maxSubagentDepth(agentDefs, env);
  if (depth >= maxDepth) {
    return (
      `Delegation depth limit reached (this session is ${depth} hops deep, max-depth ${maxDepth}). ` +
      `Do this work yourself, or raise max-depth / PI_SUBAGENT_MAX_DEPTH if deeper delegation is truly required.`
    );
  }
  if (resolveEffectiveSessionMode(params, agentDefs) === "fork" && depth >= 1) {
    return (
      `A fork child (depth ${depth}) may not fork again: each fork re-reads a whole parent branch, ` +
      `so forks compound. Use session-mode digest for cheap context, or pass fork: false.`
    );
  }
  return null;
}

export function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const configDir = getAgentConfigDir();
  const paths = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(configDir, "agents", `${agentName}.md`),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }

  return null;
}
