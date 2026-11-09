import type { DashboardChild, DashboardEscalation, DashboardHandoff, DashboardReview, DashboardSnapshot, DashboardSpecReview } from "./protocol.ts";
import { validateView, type GraphEdge, type GraphNode, type GraphWebView, type ListStatus, type WebView } from "../web-plugins/view.ts";

/** Web plugin id and the read-only sync action it declares. Shared by the extension and its descriptor. */
export const SUBAGENT_MONITOR_PLUGIN_ID = "subagent-monitor";
export const SUBAGENT_MONITOR_SYNC_ACTION = "request-sync";

const PARENT_ID = "parent";

const childStatus = (status: DashboardChild["status"]): ListStatus =>
  status === "running" ? "active"
  : status === "completed" ? "done"
  : status === "blocked" ? "blocked"
  : status === "failed" ? "failed"
  : "neutral";

const verdictStatus = (verdict: string): ListStatus =>
  verdict === "accepted" ? "done"
  : verdict === "changes-requested" || verdict === "rejected" ? "failed"
  : "neutral";

function childDetail(child: DashboardChild, handoff: DashboardHandoff | undefined): string {
  const lines: string[] = [`**Status:** ${child.status}${child.pendingPing ? " · ping pending" : ""}`];
  if (child.purpose) lines.push(`**Purpose:** ${child.purpose}`);
  if (child.task) lines.push(`**Task:** ${child.task}`);
  if (child.scope) lines.push(`**Scope:** \`${child.scope}\``);
  if (handoff) {
    lines.push(`**Handoff:** ${handoff.goal}`);
    if (handoff.acceptanceCriteria.length) {
      lines.push("**Acceptance:**", ...handoff.acceptanceCriteria.map(item => `- ${item}`));
    }
  }
  if (child.closeReason) lines.push(`**Close:** ${child.closeReason}`);
  if (child.lastTokens !== undefined) {
    const window = child.lastContextWindow ? ` of ${child.lastContextWindow.toLocaleString("en-US")}` : "";
    lines.push(`**Context:** ${child.lastTokens.toLocaleString("en-US")} tokens${window}`);
  }
  if (child.budgetMs) lines.push(`**Budget:** ${Math.max(1, Math.round(child.budgetMs / 60_000))} min`);
  if (child.laneFiles.length) lines.push(`**Lane:** ${child.laneFiles.map(file => `\`${file}\``).join(", ")}`);
  if (child.artifactIds?.length) lines.push(`**Artifacts:** ${child.artifactIds.join(", ")}`);
  if (child.updatedAt) lines.push(`**Updated:** ${child.updatedAt}`);
  return lines.join("\n");
}

function reviewDetail(review: DashboardReview): string {
  const lines = [
    `**Verdict:** ${review.verdict}`,
    `**Summary:** ${review.summary}`,
  ];
  if (review.timestamp) lines.push(`**At:** ${review.timestamp}`);
  return lines.join("\n");
}

function escalationDetail(escalation: DashboardEscalation): string {
  return [`**Question:** ${escalation.question}`, `**Stage:** ${escalation.stage}`].join("\n");
}

function specReviewDetail(specReview: DashboardSpecReview): string {
  const lines = [
    `**Status:** ${specReview.status}`,
    ...(specReview.reviewerIds.length ? [`**Reviewers:** ${specReview.reviewerIds.join(", ")}`] : []),
  ];
  return lines.join("\n");
}

/**
 * Pure projection from a delegated-work snapshot to the plugin graph WebView.
 *
 * The graph is what the operator reads per session: the parent session, each
 * child worker (status icon, expandable detail), handoffs as labelled edges,
 * reviews and escalations as their own nodes attached to the child they judged
 * — or to the parent when no child matches. Node and edge caps, reference
 * checks, and size clamps are enforced by the view validator; anything past
 * the caps reports `omitted` instead of failing.
 */
export function delegationToGraphView(snapshot: DashboardSnapshot | null | undefined): WebView {
  const session = snapshot?.session;
  const delegation = snapshot?.delegation ?? {
    children: [], handoffs: [], reviews: [], escalations: [], specReviews: [], paused: false,
  };
  const children = delegation.children ?? [];
  const handoffs = delegation.handoffs ?? [];
  const reviews = delegation.reviews ?? [];
  const escalations = delegation.escalations ?? [];
  const specReviews = delegation.specReviews ?? [];

  const handoffById = new Map(handoffs.map(handoff => [handoff.id, handoff]));
  const childByScope = new Map(children.filter(child => child.scope).map(child => [child.scope, child]));

  const nodes: GraphNode[] = [{
    id: PARENT_ID,
    label: session?.name?.trim() || "Session",
    kind: "parent",
    status: delegation.paused ? "blocked" : children.some(child => child.status === "running") ? "active" : "neutral",
  }];

  const edges: GraphEdge[] = [];
  for (const child of children) {
    const handoff = child.handoffId ? handoffById.get(child.handoffId) : undefined;
    nodes.push({
      id: `child:${child.id}`,
      label: child.name || child.id,
      kind: "child",
      status: childStatus(child.status),
      detail: childDetail(child, handoff),
    });
    edges.push({ from: PARENT_ID, to: `child:${child.id}`, ...(handoff ? { label: handoff.goal } : {}) });
  }

  for (const review of reviews) {
    nodes.push({
      id: `review:${review.id}`,
      label: `review · ${review.scope}`,
      kind: "review",
      status: verdictStatus(review.verdict),
      detail: reviewDetail(review),
    });
    const target = (review.scope && childByScope.get(review.scope)) || children.find(child => child.reviewRunId === review.id);
    edges.push({ from: target ? `child:${target.id}` : PARENT_ID, to: `review:${review.id}`, label: "review" });
  }

  for (const escalation of escalations) {
    nodes.push({
      id: `escalation:${escalation.id}`,
      label: escalation.question,
      kind: "escalation",
      status: "blocked",
      detail: escalationDetail(escalation),
    });
    const target = (escalation.childId && children.find(child => child.id === escalation.childId))
      || (escalation.scope && childByScope.get(escalation.scope));
    edges.push({ from: target ? `child:${target.id}` : PARENT_ID, to: `escalation:${escalation.id}`, label: "escalation" });
  }

  for (const specReview of specReviews) {
    nodes.push({
      id: `spec:${specReview.id}`,
      label: specReview.title || specReview.id,
      kind: "review",
      status: verdictStatus(specReview.status),
      detail: specReviewDetail(specReview),
    });
    edges.push({ from: PARENT_ID, to: `spec:${specReview.id}`, label: "spec review" });
  }

  const rawView: GraphWebView = {
    type: "graph",
    ...(session?.name?.trim() ? { title: session.name.trim() } : {}),
    nodes,
    edges,
  };
  const validated = validateView(rawView);
  if (validated.ok) return validated.view;
  return rawView;
}
