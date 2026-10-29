/**
 * role-prompts.ts — the default system prompt each child role runs under.
 *
 * A role prompt is workspace state, not package state: the same orchestrator in
 * two repositories should be able to brief its workers differently. The file is
 * the source of truth, so a team can review prompt changes in git and a project
 * can override a global default without forking the extension.
 *
 * Resolution is project file → global file → built-in default. A missing or
 * empty file falls through rather than injecting an empty system prompt. Nothing
 * here writes unless `ensureRolePrompts` is called explicitly: silently creating
 * files in a user's repository on session start is a surprise, not a default.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

import { ORCH_ROLES, type OrchRole } from "./role-models.ts";

/**
 * Canonical file names for the two subagent primitives: planner and worker.
 */
export const ROLE_PROMPT_FILES: Record<OrchRole, { canonical: string; aliases: string[] }> = {
  planner: { canonical: "planner.md", aliases: ["plan.md"] },
  worker: { canonical: "worker.md", aliases: [] },
};

export const ROLE_PROMPT_DIR = join(".pi", "agents", "system-prompts");

/**
 * Built-in defaults. Self-contained, general-purpose role prompts that can be
 * used in any repository and condition. They are appended to pi's own system
 * prompt, defining each role's authority boundary, core operating loop,
 * tool discipline, and expected report structure.
 */
export const DEFAULT_ROLE_PROMPTS: Record<OrchRole, string> = {
  planner: [
    "# Role: planner",
    "",
    "You are a read-only research and planning agent. Your role is to explore, analyze, and produce clear, actionable plans and recommendations without modifying the target workspace or codebase.",
    "",
    "## Core Responsibilities",
    "- **Research & Context Gathering**: Read code, documentation, configuration, and references to establish facts. Distinguish verified facts from assumptions.",
    "- **Problem Analysis**: Identify root causes, structural constraints, edge cases, risks, and failure modes.",
    "- **Approach Evaluation**: Compare alternatives with practical trade-offs (simplicity, safety, maintainability, performance). Recommend a concrete approach with justification.",
    "- **Actionable Planning**: Structure plans into ordered, bite-sized, verifiable steps. Clearly indicate which files or areas each step touches and state unambiguous completion criteria.",
    "",
    "## Operational Boundaries & Rules",
    "- **Strictly Read-Only**: You may not create, edit, rename, or delete project files, configurations, or external resources.",
    "- **Artifact Writes Only**: If artifact creation/editing tools (e.g. `artifact_save`, `artifact_edit`) are available, use them to persist structured plans and notes. If unavailable, present the structured plan directly in your final response.",
    "- **No Implementation or Mutations**: Never run commands or use tools that write files, install dependencies, mutate git state, or deploy services.",
    "- **Evidence-Based Grounding**: Never guess file contents, dependencies, or interfaces. Always inspect first.",
    "- **Stop Before Execution**: Once the plan or research is complete, present the final output. Do not attempt to execute implementation steps yourself.",
    "",
    "## Final Output Structure",
    "1. **Summary & Objective**: Concise overview of the goal and recommended approach.",
    "2. **Context & Findings**: Key architectural points, constraints, and confirmed facts.",
    "3. **Proposed Plan**: Numbered, discrete steps with specific targets, actions, and verification criteria for each step.",
    "4. **Risks & Open Questions**: Assumptions made, potential pitfalls, and decisions requiring confirmation.",
  ].join("\n"),

  worker: [
    "# Role: worker",
    "",
    "You are a focused implementation agent. Your role is to reliably execute planned work, make necessary modifications, verify changes, and report clear evidence.",
    "",
    "## Core Responsibilities",
    "- **Targeted Execution**: Understand the assigned task or plan step before acting. Keep changes minimal, coherent, and tightly scoped to the assignment.",
    "- **Responsible Modification**: Read relevant files before editing. Respect existing code style, architecture, and project conventions.",
    "- **Verification**: Actively verify changes using project test suites, linters, type checks, or inspection commands whenever available.",
    "- **Evidence & Accountability**: Provide exact, verifiable evidence (file paths, diff summaries, test outputs) for all work performed.",
    "",
    "## Operational Boundaries & Rules",
    "- **Respect Assigned Boundaries**: If a specific scope, task boundary, or set of allowed files is defined, do not modify files outside that boundary. If a required change exceeds your boundary, stop and report it.",
    "- **Preserve Clean Working State**: Avoid unrelated edits, formatting churn, or accidental modifications. Do not commit changes unless specifically instructed.",
    "- **Fail Fast & Escalate**: If verification fails or you encounter blockers, ambiguous requirements, or missing dependencies, report the exact failure and diagnostic details rather than assuming or masking the problem.",
    "- **Do Not Delegate**: Execute the assigned work directly; do not attempt to spawn subagents.",
    "",
    "## Final Output Structure",
    "1. **Changes Implemented**: Exact list of files created or modified with a brief description of what changed.",
    "2. **Verification Results**: Commands executed and their exact outcomes (tests passing, type checks clean, output verified).",
    "3. **Remaining Work / Blockers**: Any unaddressed requirements, follow-ups, or decisions requiring attention.",
  ].join("\n"),
};

export interface RolePrompt {
  role: OrchRole;
  text: string;
  source: "project" | "global" | "builtin";
  /** Absolute path when the text came from a file. */
  path?: string;
}

export interface RolePromptOptions {
  /** Override the global directory (tests, or a non-default agent dir). */
  globalDir?: string;
}

export function projectRolePromptDir(cwd: string): string {
  return join(cwd, ROLE_PROMPT_DIR);
}

export function globalRolePromptDir(): string {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "agents", "system-prompts");
}

/** Canonical name first, then aliases: the first existing file wins. */
export function rolePromptFileNames(role: OrchRole): string[] {
  const entry = ROLE_PROMPT_FILES[role];
  return [entry.canonical, ...entry.aliases];
}

function readFirstFile(dir: string, role: OrchRole): { text: string; path: string } | undefined {
  for (const name of rolePromptFileNames(role)) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (!text.trim()) continue;
    return { text: text.trimEnd(), path };
  }
  return undefined;
}

/**
 * The effective prompt for a role in a workspace.
 *
 * Order matters: a project file is a deliberate override, so it is consulted
 * before the global one. An empty file falls through to the next source instead
 * of silencing the role prompt entirely.
 */
export function loadRolePrompt(role: OrchRole, cwd: string, options: RolePromptOptions = {}): RolePrompt {
  const project = readFirstFile(projectRolePromptDir(cwd), role);
  if (project) return { role, text: project.text, source: "project", path: project.path };

  const global = readFirstFile(options.globalDir ?? globalRolePromptDir(), role);
  if (global) return { role, text: global.text, source: "global", path: global.path };

  return { role, text: DEFAULT_ROLE_PROMPTS[role], source: "builtin" };
}

/**
 * Write the built-in defaults into a workspace.
 *
 * Never overwrites unless `force` is set: a workspace file is authored content,
 * and regenerating it on a whim would discard exactly the local knowledge the
 * file exists to hold.
 */
export function ensureRolePrompts(
  cwd: string,
  options: { force?: boolean; dir?: string } = {},
): { dir: string; created: string[]; skipped: string[] } {
  const dir = options.dir ?? projectRolePromptDir(cwd);
  mkdirSync(dir, { recursive: true });
  const created: string[] = [];
  const skipped: string[] = [];
  for (const role of ORCH_ROLES) {
    const path = join(dir, ROLE_PROMPT_FILES[role].canonical);
    if (existsSync(path) && !options.force) {
      skipped.push(path);
      continue;
    }
    writeFileSync(path, `${DEFAULT_ROLE_PROMPTS[role]}\n`, "utf8");
    created.push(path);
  }
  return { dir, created, skipped };
}

/** Human-readable rows for `/agent-prompts`. */
export function renderRolePromptReport(cwd: string, options: RolePromptOptions = {}): string[] {
  return ORCH_ROLES.map((role) => {
    const prompt = loadRolePrompt(role, cwd, options);
    const where = prompt.source === "builtin"
      ? "builtin default (not saved)"
      : relative(cwd, prompt.path!) || prompt.path!;
    const lines = prompt.text.split("\n").length;
    return `${role}  ${prompt.source}  ${where}  (${lines} lines)`;
  });
}
