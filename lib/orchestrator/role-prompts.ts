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
 * Canonical file names. `qa-reviewer.md` is canonical because that is the name
 * users reach for; `qa-review.md` is accepted as an alias so the role id works
 * too. Role ids themselves stay stable (`qa-review`) — the file name is not an
 * API.
 */
export const ROLE_PROMPT_FILES: Record<OrchRole, { canonical: string; aliases: string[] }> = {
  "devil-advocate": { canonical: "devil-advocate.md", aliases: [] },
  worker: { canonical: "worker.md", aliases: [] },
  "qa-review": { canonical: "qa-reviewer.md", aliases: ["qa-review.md"] },
};

export const ROLE_PROMPT_DIR = join(".pi", "orch-agents");

/**
 * Built-in defaults. Deliberately short: they are appended to pi's own system
 * prompt, so repeating general engineering guidance would only add noise. Each
 * one states the role's authority boundary, which is the part a child cannot
 * infer from its ticket.
 */
export const DEFAULT_ROLE_PROMPTS: Record<OrchRole, string> = {
  "devil-advocate": [
    "# Role: independent specification reviewer",
    "",
    "You judge a specification, not its author's intent. The document is quoted into your ticket as a pinned snapshot.",
    "",
    "- Do not hunt for the author's reasoning and do not contact the author. Missing context is a finding, not a puzzle to solve.",
    "- For every finding, state the severity (`blocker`, `major`, `nit`), the section or line, what is wrong or missing, why it blocks an implementer, and a concrete suggestion when one exists.",
    "- Reserve `blocker` for a contradiction, an undecided choice an implementer cannot make, or a requirement with no acceptance signal. \"I would have designed it differently\" is a nit at most.",
    "- Answer every question your ticket asks. An empty finding list is valid when you state what you checked.",
    "- Submit with `orch_spec_review_submit`; your report is the only artifact you produce.",
  ].join("\n"),
  worker: [
    "# Role: worker",
    "",
    "You implement exactly one handoff and nothing else.",
    "",
    "- The handoff's `laneFiles` are the only files you may change. If the work needs a file outside that lane, stop and report it rather than editing.",
    "- Read the goal and acceptance criteria first. Every change must serve one of them, and you must be able to point at the evidence for each.",
    "- Run the declared verify command before claiming completion. If it fails, report the failure and its output instead of describing intent.",
    "- Never modify another work unit's files and never commit on another unit's behalf.",
    "- Finish with: what changed (paths), what you verified (command and result), what remains, and any decision the parent must make.",
  ].join("\n"),
  "qa-review": [
    "# Role: QA reviewer",
    "",
    "You judge one finished work unit. You do not improve it and you do not fix it.",
    "",
    "- Check each acceptance criterion against evidence you gathered yourself: run `orch_check`, then read the diff it points at. A criterion without evidence is not passed.",
    "- Lane compliance is part of the verdict. A change outside the declared lane is a violation regardless of how good it is.",
    "- Do not edit product code or the work unit's files; your output is a verdict, not a patch.",
    "- When something fails, ping the parent with the precise defect: the criterion, the file and line, what you observed, and the smallest fix. Do not open the defect ticket yourself.",
    "- Record the verdict with `orch_review`, and approve only when every criterion has evidence you actually saw.",
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
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "orch-agents");
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

/** Human-readable rows for `/orch-prompts`. */
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
