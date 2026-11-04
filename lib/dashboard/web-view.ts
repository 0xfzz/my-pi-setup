import type { DashboardSnapshot } from "./protocol.ts";
import { validateView, type KvRow, type KvWebView, type WebView } from "../web-plugins/view.ts";

/**
 * Pure projection from a projected dashboard snapshot to the plugin kv WebView contract.
 *
 * Implements data parity with the standalone dashboard:
 * - includes every child (id/name/status/scope), handoff, review, escalation, spec review,
 *   and artifact summary (title/type/version/tags/id — never content);
 * - counts rows (children, handoffs, reviews, artifacts) are first;
 * - rows past the 200 cap or 64 KB limit are truncated by the view validator and report `omitted`.
 */
export function snapshotToWebView(snapshot: DashboardSnapshot): WebView {
  const session = snapshot?.session;
  const delegation = snapshot?.delegation ?? {
    children: [],
    handoffs: [],
    reviews: [],
    escalations: [],
    specReviews: [],
    paused: false,
  };
  const artifacts = snapshot?.artifacts ?? [];

  const children = delegation.children ?? [];
  const handoffs = delegation.handoffs ?? [];
  const reviews = delegation.reviews ?? [];
  const escalations = delegation.escalations ?? [];
  const specReviews = delegation.specReviews ?? [];

  const rows: KvRow[] = [
    { label: "children", value: String(children.length) },
    { label: "handoffs", value: String(handoffs.length) },
    { label: "reviews", value: String(reviews.length) },
    { label: "artifacts", value: String(artifacts.length) },
    { label: "session", value: session?.id ?? "" },
    { label: "mode", value: session?.mode ?? "normal" },
    { label: "paused", value: String(Boolean(delegation.paused)) },
  ];

  for (const child of children) {
    const label = `child · ${child.name || child.id}`;
    const taskPart = child.task ? ` · ${child.task.trim()}` : "";
    const idPart = child.id ? ` · ${child.id}` : "";
    const value = `${child.status} · ${child.scope}${taskPart}${idPart}`;
    rows.push({ label, value });
  }

  for (const handoff of handoffs) {
    const label = `handoff · ${handoff.scope}`;
    const idPart = handoff.id ? ` · ${handoff.id}` : "";
    const value = `${handoff.goal}${idPart}`;
    rows.push({ label, value });
  }

  for (const review of reviews) {
    const label = `review · ${review.scope}`;
    const idPart = review.id ? ` · ${review.id}` : "";
    const value = `${review.verdict} · ${review.summary}${idPart}`;
    rows.push({ label, value });
  }

  for (const esc of escalations) {
    const target = esc.scope || esc.childId || esc.id;
    const label = `escalation · ${target}`;
    const idPart = esc.id && target !== esc.id ? ` · ${esc.id}` : "";
    const value = `${esc.stage} · ${esc.question}${idPart}`;
    rows.push({ label, value });
  }

  for (const sr of specReviews) {
    const label = `spec review · ${sr.title || sr.id}`;
    const idPart = sr.id && sr.title !== sr.id ? ` · ${sr.id}` : "";
    const value = `${sr.status}${idPart}`;
    rows.push({ label, value });
  }

  for (const art of artifacts) {
    const label = `artifact · ${art.title || art.id}`;
    const tagsPart = art.tags?.length ? ` · ${art.tags.join(", ")}` : "";
    const idPart = art.id && art.title !== art.id ? ` · ${art.id}` : "";
    const value = `${art.type} v${art.version}${tagsPart}${idPart}`;
    rows.push({ label, value });
  }

  const title = session?.name && session.name.trim() ? session.name.trim() : undefined;

  const rawView: KvWebView = {
    type: "kv",
    ...(title ? { title } : {}),
    rows,
  };

  const validated = validateView(rawView);
  if (validated.ok) {
    return validated.view;
  }
  return rawView;
}
