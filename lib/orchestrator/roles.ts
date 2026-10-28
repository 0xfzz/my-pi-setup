/**
 * Planner/worker roles — one plan artifact, no review pipeline.
 *
 * The planner is a read-only child that writes a plan artifact. A worker step
 * inlines one step of that plan into its ticket; it does not re-derive it and it
 * does not hash-bind it. The plan is a durable handoff, not a gate.
 */
export interface PlanStep {
  id: string;
  goal: string;
  files: string[];
  acceptanceCriteria: string[];
  dependsOn?: string[];
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
}

export type PlanParse = { ok: true; plan: Plan } | { ok: false; problems: string[] };

/** Strip the `NNN│ ` gutter and the artifact header from an `artifact_recall` reply. */
export function stripRecallFrame(text: string): string {
  const lines = String(text ?? "").split("\n");
  if (lines[0]?.startsWith("=== Artifact:")) lines.shift();
  return lines.map((line) => line.replace(/^\s*\d+│ ?/, "")).join("\n");
}

/**
 * Parse the plan contract: the first ```json fence in the artifact.
 *
 * A plan with no steps, a step with no goal/criteria, or a lane-less step is
 * rejected: those are the three ways a plan stops being executable.
 */
export function parsePlan(text: string): PlanParse {
  const fence = String(text ?? "").match(/```json\s*\n([\s\S]*?)```/);
  if (!fence) return { ok: false, problems: ["no ```json block found in the plan artifact"] };
  let raw: any;
  try {
    raw = JSON.parse(fence[1]!);
  } catch (error: any) {
    return { ok: false, problems: [`plan JSON does not parse: ${error?.message ?? error}`] };
  }
  const problems: string[] = [];
  const summary = typeof raw?.summary === "string" ? raw.summary.trim() : "";
  if (!summary) problems.push("summary is required");
  if (!Array.isArray(raw?.steps) || raw.steps.length === 0) {
    return { ok: false, problems: [...problems, "steps[] must be a non-empty array"] };
  }
  const seen = new Set<string>();
  const steps: PlanStep[] = [];
  raw.steps.forEach((step: any, index: number) => {
    const id = typeof step?.id === "string" && step.id.trim() ? step.id.trim() : String(index + 1);
    const goal = typeof step?.goal === "string" ? step.goal.trim() : "";
    const files = Array.isArray(step?.files) ? step.files.filter((f: unknown) => typeof f === "string" && f.trim()) : [];
    const acceptanceCriteria = Array.isArray(step?.acceptanceCriteria)
      ? step.acceptanceCriteria.filter((c: unknown) => typeof c === "string" && c.trim())
      : [];
    if (seen.has(id)) problems.push(`step ${id} is declared twice`);
    seen.add(id);
    if (!goal) problems.push(`step ${id} has no goal`);
    if (!files.length) problems.push(`step ${id} owns no files (a worker needs a lane)`);
    if (!acceptanceCriteria.length) problems.push(`step ${id} has no acceptance criteria`);
    steps.push({ id, goal, files, acceptanceCriteria, ...(Array.isArray(step?.dependsOn) ? { dependsOn: step.dependsOn.filter((d: unknown) => typeof d === "string") } : {}) });
  });
  return problems.length ? { ok: false, problems } : { ok: true, plan: { summary, steps } };
}

/** The planner's ticket: read-only, and the artifact contract is exact. */
export function buildPlannerTicket(input: { scope: string; planId: string; task: string }): string {
  return `# Planner task: ${input.scope}

You are a **planner**. You do not implement. Inspect the repository, then write one
plan artifact and finish.

## Assignment
${String(input.task ?? "").trim()}

## Output contract
Save artifact \`${input.planId}\` with \`artifact_save\` (type: "plan"), containing a
short summary and a fenced json block:

\`\`\`json
{
  "summary": "one paragraph",
  "steps": [
    { "id": "1", "goal": "...", "files": ["path/owned.ts"], "acceptanceCriteria": ["testable check"] }
  ]
}
\`\`\`

Rules: every step owns at least one file (that is its lane); every step has at
least one testable criterion; ids are unique. Keep steps independent where you
can. Then call \`agent_done\` with the plan id.

## Boundaries
Read anything. Do not modify files. Do not spawn children.
`;
}

/** A worker's ticket for one plan step. */
export function buildPlanStepTicket(input: {
  scope: string;
  planId: string;
  plan: Plan;
  step: PlanStep;
  task: string;
}): string {
  const { step } = input;
  const files = step.files.map((file) => `- \`${file}\``).join("\n");
  const criteria = step.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n");
  return `# Work handoff: ${input.scope} (plan ${input.planId}, step ${step.id})

## Plan summary
${input.plan.summary}

## This step
${step.goal}

${String(input.task ?? "").trim() ? `## Additional assignment\n${String(input.task).trim()}\n` : ""}

## Files you own (your lane)
${files}

## Acceptance criteria — each must be evidenced in your report
${criteria}

## Boundaries
You own the files above and nothing else. If the step cannot be done without
changing another file, escalate with \`agent_ping\` instead of editing it.
`;
}
