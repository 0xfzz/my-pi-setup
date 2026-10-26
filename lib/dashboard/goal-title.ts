/** Branch-owned, user-goal identity. Never reads transcripts or child plans. */
import { meaningfulSessionTitle, sessionTitle } from "../../web/dashboard/src/naming.mjs";

export const DASHBOARD_GOAL_ENTRY = "workflow-dashboard-goal:v1";
export interface GoalTitleRecord {
  v: 1;
  ownerSessionId: string;
  title: string;
  source: "goal" | "rename" | "seed";
}

export function latestGoalTitle(branch: readonly any[], ownerSessionId: string): GoalTitleRecord | undefined {
  let latest: GoalTitleRecord | undefined;
  for (const entry of branch) {
    if (entry?.type !== "custom" || entry.customType !== DASHBOARD_GOAL_ENTRY) continue;
    const data = entry.data;
    if (data?.v !== 1 || data.ownerSessionId !== ownerSessionId || typeof data.title !== "string") continue;
    if (!["goal", "rename", "seed"].includes(data.source)) continue;
    latest = { v: 1, ownerSessionId, title: meaningfulSessionTitle(data.title), source: data.source };
  }
  return latest;
}

/**
 * A plan can seed a title once, not rename it on every plan replacement. Only
 * explicitly owned, durable declarations count. First declaration wins: review
 * and verification plans later in the branch cannot steal session identity.
 * New objectives are explicitly recorded via session_goal or Pi's /name.
 */
export function initialPlanTitle(branch: readonly any[], ownerSessionId: string): string {
  for (const entry of branch) {
    const data = entry?.data;
    if (entry?.type !== "custom" || entry.customType !== "workflow-todo:v2") continue;
    if (data?.ownerSessionId !== ownerSessionId || data.v !== 2 || data.kind !== "plan") continue;
    if (data.plan?.scope !== "committed") continue;
    const title = meaningfulSessionTitle(data.plan.goal);
    if (title) return title;
  }
  return "";
}

export function resolveGoalTitle(input: {
  branch: readonly any[];
  ownerSessionId: string;
  sessionName?: string;
  project?: string;
}): string {
  const record = latestGoalTitle(input.branch, input.ownerSessionId);
  // Empty records are intentional clears; don't resurrect an old plan/name.
  if (record) return sessionTitle({ project: input.project, goalTitle: record.title });
  return sessionTitle({
    project: input.project,
    sessionName: input.sessionName,
    goalTitle: meaningfulSessionTitle(input.sessionName, { project: input.project })
      ? undefined : initialPlanTitle(input.branch, input.ownerSessionId),
  });
}
