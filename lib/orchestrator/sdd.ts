/**
 * sdd.ts — the lean SDD artifact layer.
 *
 * One feature is `specs/<feature>/spec.md`, `plan.md`, `tasks.md`. Actions that
 * create a file are create-only: a changed requirement creates a new feature
 * directory (`<feature>-v2`) instead of silently rewriting a reviewed contract.
 * `clarify` appends a Q/A and resolves one open question; `converge` is a
 * documented append-only convention, not a tool here.
 *
 * Everything in this module is pure filesystem + Markdown. The orchestrator tool
 * adds mode/workflow gating and review decoration.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export class SddError extends Error {}

const FEATURE_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const TASK_ID = /^T\d{3,}$/;
const REQUIREMENT_ID = /^FR-\d{3,}$/;
const ACCEPTANCE_ID = /^AC-\d{3,}$/;

export type SddFindingCode = "SDD-SECTION" | "SDD-ID" | "SDD-MAP" | "SDD-DEP" | "SDD-LANE";

export interface SddFinding {
  code: SddFindingCode;
  location: string;
  message: string;
}

export interface SddRequirement {
  id: string;
  text: string;
}

export interface SddAcceptance {
  id: string;
  text: string;
}

export interface SddOpenQuestion {
  text: string;
  done: boolean;
}

export interface SddSpec {
  content: string;
  status: string;
  requirements: SddRequirement[];
  acceptance: SddAcceptance[];
  openQuestions: SddOpenQuestion[];
}

export interface SddTask {
  id: string;
  title: string;
  parallel: boolean;
  dependsOn: string[];
  maps: string[];
  files: string[];
  verify?: string;
  done: boolean;
  phase: string;
  line: number;
}

export interface SddTaskInput {
  id?: string;
  title: string;
  dependsOn?: string[];
  parallel?: boolean;
  maps?: string[];
  files?: string[];
  verify?: string;
  phase?: string;
}

export interface SddSpecifyInput {
  feature: string;
  title: string;
  problem: string;
  goals?: string[];
  nonGoals?: string[];
  requirements: string[];
  acceptance: string[];
  constraints?: string[];
  outOfScope?: string[];
  openQuestions?: string[];
  parentRoadmap?: string;
  sliceId?: string;
}

export interface SddPlanInput {
  feature: string;
  approach: string;
  files?: string[];
  interfaces?: string[];
  testStrategy: string[];
  risks?: string[];
  taskMapping?: string;
}

export interface SddTasksInput {
  feature: string;
  tasks: SddTaskInput[];
}

export interface SddWriteResult {
  featureDir: string;
  file: string;
  content: string;
}

export interface SddAnalyzeResult {
  featureDir: string;
  findings: SddFinding[];
  ok: boolean;
}

export interface SddStatus {
  featureDir: string;
  files: { spec: boolean; plan: boolean; tasks: boolean };
  specStatus: string | null;
  taskCount: number;
  doneCount: number;
  ready: SddTask[];
  parallelGroups: SddTask[][];
  findings: SddFinding[];
}

export interface SddHandoffTask {
  id: string;
  title: string;
  maps: string[];
  files: string[];
  verify?: string;
}

export interface SddHandoffRef {
  featureDir: string;
  taskIds: string[];
  tasks?: SddHandoffTask[];
}

export interface SddTaskSelection {
  featureDir: string;
  featureRef: string;
  tasks: SddTask[];
  laneFiles: string[];
  acceptanceCriteria: string[];
  verifyCommand?: string;
}

export function sddTaskSnapshot(task: SddTask): SddHandoffTask {
  return {
    id: task.id,
    title: task.title,
    maps: [...task.maps],
    files: [...task.files],
    ...(task.verify ? { verify: task.verify } : {}),
  };
}

/**
 * Freeze the selected tasks into a handoff slice.
 *
 * The handoff is the authority for the child; tasks.md is re-read at spawn so a
 * task completed or edited after authoring cannot be implemented twice against a
 * stale ticket.
 */
export function sddTaskSelection(
  cwd: string,
  feature: unknown,
  taskIds: readonly string[],
): SddTaskSelection {
  const ids = [...new Set(taskIds.map((id) => String(id).trim()).filter(Boolean))];
  if (!ids.length) throw new SddError("sdd.taskIds needs at least one task id.");
  for (const id of ids) {
    if (!TASK_ID.test(id)) throw new SddError(`Task id "${id}" must look like T001.`);
  }
  const { featureDir, slug } = sddFeatureDir(cwd, feature);
  const tasks = readSddTasks(cwd, feature);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const selected = ids.map((id) => {
    const task = byId.get(id);
    if (!task) throw new SddError(`Task ${id} is not in tasks.md.`);
    if (task.done) throw new SddError(`Task ${id} is already done.`);
    return task;
  });
  for (const task of selected) {
    for (const dep of task.dependsOn) {
      const dependency = byId.get(dep);
      if (!dependency) throw new SddError(`Task ${task.id} depends on unknown ${dep}.`);
      if (!dependency.done) throw new SddError(`Task ${task.id} depends on ${dep}, which is not done.`);
    }
  }
  const laneFiles = [...new Set(selected.flatMap((task) => task.files))];
  if (!laneFiles.length) throw new SddError("The selected tasks have no files, so there is no lane.");
  const criteria = selected.map((task) => `${task.id}: ${task.title} — maps ${task.maps.join(", ")}`);
  const verifyCommand = selected.every((task) => task.verify && task.verify === selected[0]!.verify)
    ? selected[0]!.verify
    : undefined;
  return { featureDir, featureRef: `specs/${slug}`, tasks: selected, laneFiles, acceptanceCriteria: criteria, verifyCommand };
}

/** Revalidate a handoff's frozen slice against the current tasks.md. */
export function sddTaskSelectionProblem(cwd: string, ref: SddHandoffRef): string | undefined {
  try {
    const selection = sddTaskSelection(cwd, ref.featureDir, ref.taskIds);
    if (ref.tasks?.length) {
      const current = selection.tasks.map(sddTaskSnapshot);
      if (JSON.stringify(current) !== JSON.stringify(ref.tasks)) {
        return "the SDD task slice changed since this handoff was authored; re-author the handoff";
      }
    }
    return undefined;
  } catch (error: any) {
    return error instanceof SddError ? error.message : (error?.message ?? String(error));
  }
}

const SPEC_SECTIONS = [
  "Problem",
  "Goals",
  "Non-goals",
  "Requirements",
  "Acceptance scenarios",
  "Constraints and assumptions",
  "Clarifications",
  "Open questions",
  "Out of scope",
] as const;

const PLAN_SECTIONS = [
  "Approach",
  "Affected files/interfaces",
  "Test strategy",
  "Risks",
  "Task mapping",
] as const;

function inside(candidate: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function pathExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function rejectSymlink(path: string, label: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new SddError(`${label} must not be a symlink (${path}).`);
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

/** Validate a feature argument as one slug; accept the common `specs/<slug>` spelling. */
export function sddFeatureSlug(value: unknown): string {
  if (typeof value !== "string") throw new SddError("feature must be a slug such as retry-policy.");
  let slug = value.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (slug.startsWith("specs/")) slug = slug.slice("specs/".length);
  if (!FEATURE_SLUG.test(slug)) {
    throw new SddError(`Invalid feature "${value}". Use one lowercase slug: [a-z0-9-], with no slashes or traversal.`);
  }
  return slug;
}

function specsRoot(cwd: string): string {
  return join(cwd, "specs");
}

/** Resolve a feature directory, creating it only when asked, and never escape specs/. */
export function sddFeatureDir(cwd: string, feature: unknown, create = false): { featureDir: string; slug: string } {
  const slug = sddFeatureSlug(feature);
  const root = specsRoot(cwd);
  const rootExists = pathExists(root);
  if (rootExists) rejectSymlink(root, "specs/");
  if (!rootExists) {
    if (!create) throw new SddError(`No SDD feature "${slug}": specs/ does not exist. Create it with orch_sdd specify.`);
    mkdirSync(root, { recursive: true, mode: 0o755 });
  }
  const rootReal = realpathSync(root);
  if (!inside(rootReal, cwd)) throw new SddError("specs/ resolves outside the repository; refusing to write.");

  const dir = join(root, slug);
  const dirExists = pathExists(dir);
  if (dirExists) rejectSymlink(dir, `specs/${slug}/`);
  if (!dirExists) {
    if (!create) throw new SddError(`No SDD feature "${slug}". Create it with orch_sdd specify.`);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
  const dirReal = realpathSync(dir);
  if (!inside(dirReal, rootReal)) throw new SddError(`specs/${slug}/ resolves outside specs/; refusing to write.`);
  return { featureDir: dirReal, slug };
}

export function sddFeatureFile(cwd: string, feature: unknown, name: "spec.md" | "plan.md" | "tasks.md"): string {
  const { featureDir } = sddFeatureDir(cwd, feature);
  return join(featureDir, name);
}

function writeAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(temp, content, { encoding: "utf8", mode: 0o644 });
    renameSync(temp, file);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function writeNew(file: string, content: string, label: string): void {
  if (pathExists(file)) {
    throw new SddError(`${label} already exists. SDD artifacts are create-only; create a new feature directory (<feature>-v2) for a changed contract, or edit in Normal mode.`);
  }
  writeAtomic(file, content);
}

function list(items: readonly string[] | undefined, empty = "- None."): string {
  const clean = (items ?? []).map((item) => String(item).trim()).filter(Boolean);
  return clean.length ? clean.map((item) => `- ${item}`).join("\n") : empty;
}

function pad(index: number): string {
  return String(index + 1).padStart(3, "0");
}

function renderSpec(input: SddSpecifyInput, slug: string): string {
  const goals = (input.goals ?? []).map(String).map((s) => s.trim()).filter(Boolean);
  const requirements = input.requirements.map(String).map((s) => s.trim()).filter(Boolean);
  const acceptance = input.acceptance.map(String).map((s) => s.trim()).filter(Boolean);
  const open = (input.openQuestions ?? []).map(String).map((s) => s.trim()).filter(Boolean);
  if (!input.title?.trim()) throw new SddError("A feature spec needs a title.");
  if (!input.problem?.trim()) throw new SddError("A feature spec needs a problem statement.");
  if (!goals.length) throw new SddError("A feature spec needs at least one goal.");
  if (!requirements.length) throw new SddError("A feature spec needs at least one requirement.");
  if (!acceptance.length) throw new SddError("A feature spec needs at least one acceptance scenario.");
  if (Boolean(input.parentRoadmap) !== Boolean(input.sliceId)) {
    throw new SddError("parentRoadmap and sliceId must be provided together.");
  }

  const parent = input.parentRoadmap
    ? `**Input**: Parent roadmap: ${String(input.parentRoadmap).trim()} → entry **${String(input.sliceId).trim()}**.`
    : "**Input**: Authored by the orchestrator through orch_sdd.";
  const status = open.length ? "draft" : "clarified";

  return `# Feature Specification: ${input.title.trim()}

**Feature**: specs/${slug}
**Status**: ${status}
${parent}

## Problem
${input.problem.trim()}

## Goals
${list(goals)}

## Non-goals
${list(input.nonGoals)}

## Requirements
${requirements.map((text, index) => `- **FR-${pad(index)}**: ${text}`).join("\n")}

## Acceptance scenarios
${acceptance.map((text, index) => `- **AC-${pad(index)}**: ${text}`).join("\n")}

## Constraints and assumptions
${list(input.constraints)}

## Clarifications
- None.

## Open questions
${open.length ? open.map((text) => `- [ ] ${text}`).join("\n") : "- [x] None."}

## Out of scope
${list(input.outOfScope)}
`;
}

function renderPlan(input: SddPlanInput, slug: string, title: string): string {
  const approach = String(input.approach ?? "").trim();
  const testStrategy = (input.testStrategy ?? []).map(String).map((s) => s.trim()).filter(Boolean);
  if (!approach) throw new SddError("A plan needs an approach.");
  if (!testStrategy.length) throw new SddError("A plan needs at least one test strategy item.");
  const fileLines = [
    ...(input.files ?? []).map((file) => `- File: \`${String(file).trim()}\``),
    ...(input.interfaces ?? []).map((entry) => `- Interface: ${String(entry).trim()}`),
  ];
  return `# Implementation Plan: ${title}

**Feature**: specs/${slug}
**Spec**: [spec.md](./spec.md)

## Approach
${approach}

## Affected files/interfaces
${fileLines.length ? fileLines.join("\n") : "- None identified."}

## Test strategy
${list(testStrategy)}

## Risks
${list(input.risks)}

## Task mapping
${String(input.taskMapping ?? "Pending tasks.md.").trim()}
`;
}

function normalizedTasks(input: SddTasksInput): SddTask[] {
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new SddError("tasks needs at least one task.");
  }
  const ids = new Set<string>();
  const tasks: SddTask[] = input.tasks.map((task, index) => {
    const title = String(task.title ?? "").trim();
    const files = (task.files ?? []).map(String).map((s) => s.trim()).filter(Boolean);
    const maps = (task.maps ?? []).map(String).map((s) => s.trim()).filter(Boolean);
    const dependsOn = (task.dependsOn ?? []).map(String).map((s) => s.trim()).filter(Boolean);
    const verify = String(task.verify ?? "").trim();
    const id = String(task.id ?? "").trim() || `T${pad(index)}`;
    if (!title) throw new SddError(`Task ${id} needs a title.`);
    if (!TASK_ID.test(id)) throw new SddError(`Task id "${id}" must look like T001.`);
    if (ids.has(id)) throw new SddError(`Duplicate task id "${id}".`);
    ids.add(id);
    if (!files.length) throw new SddError(`Task ${id} needs at least one file.`);
    if (!maps.length) throw new SddError(`Task ${id} needs at least one Maps reference (FR-### or AC-###).`);
    if (maps.some((ref) => !REQUIREMENT_ID.test(ref) && !ACCEPTANCE_ID.test(ref))) {
      throw new SddError(`Task ${id} has a Maps reference that is not FR-### or AC-###.`);
    }
    if (dependsOn.some((dep) => !TASK_ID.test(dep))) {
      throw new SddError(`Task ${id} has a dependency that is not T###.`);
    }
    if (!verify) throw new SddError(`Task ${id} needs a Verify command.`);
    return {
      id,
      title,
      parallel: task.parallel === true,
      dependsOn,
      maps,
      files,
      verify,
      done: false,
      phase: String(task.phase ?? "Implementation").trim() || "Implementation",
      line: 0,
    };
  });
  const known = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!known.has(dep)) throw new SddError(`Task ${task.id} depends on unknown task ${dep}.`);
    }
  }
  return tasks;
}

function renderTasks(input: SddTasksInput, slug: string, title: string): string {
  const tasks = normalizedTasks(input);
  const phases = new Map<string, SddTask[]>();
  for (const task of tasks) phases.set(task.phase, [...(phases.get(task.phase) ?? []), task]);
  const body = [...phases.entries()].map(([phase, group]) => {
    const lines = group.map((task) => [
      `- [ ] ${task.id}${task.parallel ? " [P]" : ""} ${task.title}`,
      ...(task.dependsOn.length ? [`  Depends: ${task.dependsOn.join(", ")}`] : []),
      `  Maps: ${task.maps.join(", ")}`,
      `  Files: ${task.files.join(", ")}`,
      `  Verify: ${task.verify}`,
    ].join("\n"));
    return `## ${phase}\n${lines.join("\n")}`;
  }).join("\n\n");
  return `# Tasks: ${title}

**Feature**: specs/${slug}
**Plan**: [plan.md](./plan.md)

${body}
`;
}

export function readSddSpec(cwd: string, feature: unknown): SddSpec {
  const file = sddFeatureFile(cwd, feature, "spec.md");
  if (!pathExists(file)) throw new SddError(`No spec.md for this feature. Create it with orch_sdd specify.`);
  return parseSpec(readFileSync(file, "utf8"));
}

export function readSddTasks(cwd: string, feature: unknown): SddTask[] {
  const file = sddFeatureFile(cwd, feature, "tasks.md");
  if (!pathExists(file)) throw new SddError(`No tasks.md for this feature. Create it with orch_sdd tasks.`);
  return parseTasks(readFileSync(file, "utf8"));
}

function parseSpec(content: string): SddSpec {
  const requirements = [...content.matchAll(/^-\s+\*\*(FR-\d{3,})\*\*:\s*(.+)$/gm)]
    .map((match) => ({ id: match[1]!, text: match[2]!.trim() }));
  const acceptance = [...content.matchAll(/^-\s+\*\*(AC-\d{3,})\*\*:\s*(.+)$/gm)]
    .map((match) => ({ id: match[1]!, text: match[2]!.trim() }));
  const openQuestions = [...content.matchAll(/^-\s+\[([ xX])\]\s+(.+)$/gm)]
    .map((match) => ({ text: match[2]!.trim(), done: match[1]!.toLowerCase() === "x" }));
  const status = /^\*\*Status\*\*:\s*([a-z-]+)/mi.exec(content)?.[1]?.toLowerCase() ?? "unknown";
  return { content, status, requirements, acceptance, openQuestions };
}

function parseTasks(content: string): SddTask[] {
  const tasks: SddTask[] = [];
  let phase = "Implementation";
  let current: SddTask | undefined;
  for (const [lineIndex, line] of content.split("\n").entries()) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      phase = heading[1]!.trim();
      current = undefined;
      continue;
    }
    const task = /^-\s+\[([ xX])\]\s+(T\d{3,})\s+(\[P\])?\s*(.+)$/.exec(line);
    if (task) {
      current = {
        id: task[2]!,
        title: task[4]!.trim(),
        parallel: Boolean(task[3]),
        dependsOn: [],
        maps: [],
        files: [],
        done: task[1]!.toLowerCase() === "x",
        phase,
        line: lineIndex + 1,
      };
      tasks.push(current);
      continue;
    }
    if (!current) continue;
    const field = /^\s+(Depends|Maps|Files|Verify):\s*(.*)$/.exec(line);
    if (!field) continue;
    const value = field[2]!.trim();
    if (field[1] === "Depends") current.dependsOn = value.split(/[,\s]+/).filter(Boolean);
    if (field[1] === "Maps") current.maps = value.split(/[,\s]+/).filter(Boolean);
    if (field[1] === "Files") current.files = value.split(",").map((file) => file.trim()).filter(Boolean);
    if (field[1] === "Verify") current.verify = value;
  }
  return tasks;
}

function hasHeading(content: string, heading: string): boolean {
  return new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*$`, "mi").test(content);
}

function addFinding(findings: SddFinding[], code: SddFindingCode, location: string, message: string): void {
  if (findings.some((finding) => finding.code === code && finding.location === location && finding.message === message)) return;
  findings.push({ code, location, message });
}

export function sddSpecify(cwd: string, input: SddSpecifyInput): SddWriteResult {
  const { featureDir, slug } = sddFeatureDir(cwd, input.feature, true);
  const file = join(featureDir, "spec.md");
  const content = renderSpec(input, slug);
  writeNew(file, content, "spec.md");
  return { featureDir, file, content };
}

export function sddClarify(cwd: string, input: { feature: string; question: string; answer: string }): SddWriteResult {
  const { featureDir } = sddFeatureDir(cwd, input.feature);
  const file = join(featureDir, "spec.md");
  if (pathExists(join(featureDir, "plan.md"))) {
    throw new SddError("clarify is only allowed before plan.md. A changed contract needs a flow-forward <feature>-v2 directory.");
  }
  const question = String(input.question ?? "").trim();
  const answer = String(input.answer ?? "").trim();
  if (!question || !answer) throw new SddError("clarify needs a question and an answer.");
  const original = readFileSync(file, "utf8");
  const lines = original.split("\n");
  const openLine = lines.findIndex((line) => {
    const match = /^-\s+\[ \]\s+(.+)$/.exec(line);
    if (!match) return false;
    const text = match[1]!.trim();
    return text === question || text.includes(question);
  });
  if (openLine < 0) throw new SddError(`No open question matches "${question}". Add the question to spec.md first.`);
  lines[openLine] = lines[openLine]!.replace("- [ ]", "- [x]");

  const clarifications = lines.findIndex((line) => /^##\s+Clarifications\s*$/i.test(line));
  if (clarifications < 0) throw new SddError("spec.md has no ## Clarifications section.");
  let insertAt = lines.length;
  for (let index = clarifications + 1; index < lines.length; index++) {
    if (/^##\s+/.test(lines[index]!)) { insertAt = index; break; }
  }
  const block = ["", `- **Q:** ${question}`, `  **A:** ${answer}`];
  // Remove a placeholder "None." so the section does not claim there are none.
  const between = lines.slice(clarifications + 1, insertAt);
  const placeholder = between.findIndex((line) => /^-\s+None\.?$/i.test(line.trim()));
  if (placeholder >= 0) between.splice(placeholder, 1);
  const next = [
    ...lines.slice(0, clarifications + 1),
    ...between,
    ...block,
    ...lines.slice(insertAt),
  ];
  const openRemain = next.some((line) => /^-\s+\[ \]\s+/.test(line));
  const content = next.join("\n").replace(/^\*\*Status\*\*:\s*draft\s*$/mi, openRemain ? "**Status**: draft" : "**Status**: clarified");
  writeAtomic(file, content);
  return { featureDir, file, content };
}

export function readSddPlan(cwd: string, feature: unknown): string {
  const file = sddFeatureFile(cwd, feature, "plan.md");
  if (!pathExists(file)) throw new SddError("No plan.md for this feature. Create it with orch_sdd plan.");
  return readFileSync(file, "utf8");
}

export function sddPlan(cwd: string, input: SddPlanInput): SddWriteResult {
  const { featureDir, slug } = sddFeatureDir(cwd, input.feature);
  const spec = readSddSpec(cwd, input.feature);
  const open = spec.openQuestions.filter((question) => !question.done);
  if (open.length) {
    throw new SddError(`Cannot plan with open questions: ${open.map((question) => question.text).join("; ")}. Run orch_sdd clarify first.`);
  }
  if (spec.status === "draft") throw new SddError("Spec is still draft. Resolve its open questions with orch_sdd clarify first.");
  const file = join(featureDir, "plan.md");
  const title = /^#\s+Feature Specification:\s*(.+)$/mi.exec(spec.content)?.[1]?.trim() ?? slug;
  const content = renderPlan(input, slug, title);
  writeNew(file, content, "plan.md");
  return { featureDir, file, content };
}

export function sddTasks(cwd: string, input: SddTasksInput): SddWriteResult {
  const { featureDir, slug } = sddFeatureDir(cwd, input.feature);
  if (!pathExists(join(featureDir, "plan.md"))) {
    throw new SddError("tasks requires plan.md. Create it with orch_sdd plan first.");
  }
  const spec = readSddSpec(cwd, input.feature);
  const title = /^#\s+Feature Specification:\s*(.+)$/mi.exec(spec.content)?.[1]?.trim() ?? slug;
  const file = join(featureDir, "tasks.md");
  const content = renderTasks(input, slug, title);
  writeNew(file, content, "tasks.md");
  return { featureDir, file, content };
}

export function sddAnalyze(cwd: string, feature: unknown): SddAnalyzeResult {
  const { featureDir } = sddFeatureDir(cwd, feature);
  const findings: SddFinding[] = [];
  const specFile = join(featureDir, "spec.md");
  const planFile = join(featureDir, "plan.md");
  const tasksFile = join(featureDir, "tasks.md");
  if (!pathExists(specFile)) {
    addFinding(findings, "SDD-SECTION", "spec.md", "spec.md is missing.");
    return { featureDir, findings, ok: false };
  }
  const specContent = readFileSync(specFile, "utf8");
  const spec = parseSpec(specContent);
  for (const section of SPEC_SECTIONS) {
    if (!hasHeading(specContent, section)) addFinding(findings, "SDD-SECTION", `spec.md:## ${section}`, `Missing required section "## ${section}".`);
  }

  if (!pathExists(planFile)) {
    addFinding(findings, "SDD-SECTION", "plan.md", "plan.md is missing.");
  } else {
    const planContent = readFileSync(planFile, "utf8");
    for (const section of PLAN_SECTIONS) {
      if (!hasHeading(planContent, section)) addFinding(findings, "SDD-SECTION", `plan.md:## ${section}`, `Missing required section "## ${section}".`);
    }
  }

  let tasks: SddTask[] = [];
  if (!pathExists(tasksFile)) {
    addFinding(findings, "SDD-SECTION", "tasks.md", "tasks.md is missing.");
  } else {
    tasks = parseTasks(readFileSync(tasksFile, "utf8"));
    if (!tasks.length) addFinding(findings, "SDD-SECTION", "tasks.md", "tasks.md has no parseable tasks.");
  }

  const requirementIds = new Set<string>();
  for (const requirement of spec.requirements) {
    if (requirementIds.has(requirement.id)) addFinding(findings, "SDD-ID", `spec.md:${requirement.id}`, `Duplicate requirement id ${requirement.id}.`);
    requirementIds.add(requirement.id);
  }
  const acceptanceIds = new Set<string>();
  for (const acceptance of spec.acceptance) {
    if (acceptanceIds.has(acceptance.id)) addFinding(findings, "SDD-ID", `spec.md:${acceptance.id}`, `Duplicate acceptance id ${acceptance.id}.`);
    acceptanceIds.add(acceptance.id);
  }
  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (taskIds.has(task.id)) addFinding(findings, "SDD-ID", `tasks.md:${task.id}`, `Duplicate task id ${task.id}.`);
    taskIds.add(task.id);
  }

  const mapped = new Set(tasks.flatMap((task) => task.maps));
  for (const task of tasks) {
    for (const ref of task.maps) {
      if (!requirementIds.has(ref) && !acceptanceIds.has(ref)) {
        addFinding(findings, "SDD-ID", `tasks.md:${task.id}`, `Task ${task.id} maps unknown ${ref}.`);
      }
    }
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency)) addFinding(findings, "SDD-ID", `tasks.md:${task.id}`, `Task ${task.id} depends on unknown ${dependency}.`);
    }
    if (!task.maps.length) addFinding(findings, "SDD-MAP", `tasks.md:${task.id}`, `Task ${task.id} has no Maps reference.`);
  }
  for (const requirement of spec.requirements) {
    if (tasks.length && !mapped.has(requirement.id)) {
      addFinding(findings, "SDD-MAP", `spec.md:${requirement.id}`, `Requirement ${requirement.id} has no task.`);
    }
  }

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, stack: string[]) => {
    if (visiting.has(id)) {
      addFinding(findings, "SDD-DEP", `tasks.md:${id}`, `Dependency cycle: ${[...stack, id].join(" → ")}.`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep, [...stack, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id, []);

  const byPhase = new Map<string, SddTask[]>();
  for (const task of tasks.filter((entry) => entry.parallel)) {
    byPhase.set(task.phase, [...(byPhase.get(task.phase) ?? []), task]);
  }
  for (const group of byPhase.values()) {
    for (let left = 0; left < group.length; left++) {
      for (let right = left + 1; right < group.length; right++) {
        const a = group[left]!;
        const b = group[right]!;
        const overlap = a.files.filter((file) => b.files.includes(file));
        if (overlap.length) {
          addFinding(findings, "SDD-LANE", `tasks.md:${a.id}/${b.id}`, `Parallel tasks ${a.id} and ${b.id} share ${overlap.join(", ")}.`);
        }
      }
    }
  }

  return { featureDir, findings, ok: findings.length === 0 };
}

export function sddStatus(cwd: string, feature: unknown): SddStatus {
  const { featureDir } = sddFeatureDir(cwd, feature);
  const specFile = join(featureDir, "spec.md");
  const planFile = join(featureDir, "plan.md");
  const tasksFile = join(featureDir, "tasks.md");
  const specStatus = pathExists(specFile) ? parseSpec(readFileSync(specFile, "utf8")).status : null;
  const tasks = pathExists(tasksFile) ? parseTasks(readFileSync(tasksFile, "utf8")) : [];
  const done = new Set(tasks.filter((task) => task.done).map((task) => task.id));
  const ready = tasks.filter((task) => !task.done && task.dependsOn.every((dep) => done.has(dep)));
  const groups: SddTask[][] = [];
  for (const task of ready.filter((entry) => entry.parallel)) {
    const group = groups.find((candidate) =>
      candidate[0]!.phase === task.phase
      && candidate[0]!.dependsOn.join(",") === task.dependsOn.join(",")
      && candidate.every((other) => !other.files.some((file) => task.files.includes(file))));
    if (group) group.push(task);
    else groups.push([task]);
  }
  return {
    featureDir,
    files: { spec: pathExists(specFile), plan: pathExists(planFile), tasks: pathExists(tasksFile) },
    specStatus,
    taskCount: tasks.length,
    doneCount: tasks.filter((task) => task.done).length,
    ready,
    parallelGroups: groups,
    findings: sddAnalyze(cwd, feature).findings,
  };
}
