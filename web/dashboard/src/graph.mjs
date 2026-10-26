/**
 * Pure projection of dashboard session state into a stable graph model, plus
 * DOT generation. No DOM, no network: the browser bundle and Node tests share
 * this file.
 *
 * Stability rules:
 *  - Node ids are derived from explicit provenance only (`childId`,
 *    `handoffId`, `reviewRunId`, `supersededIds`). Scopes never fabricate
 *    ownership.
 *  - Graphviz node/edge ids are hashes of the entity key, and nodes/edges are
 *    emitted in sorted order, so a status-only update produces a byte-identical
 *    DOT document and never needs a relayout.
 *  - `topologySignature()` covers ids, labels and edges (not statuses) so the
 *    UI can update status decorations in place.
 */

import { escapeDotString, safeText } from "./sanitize.mjs";
import {
  assignGivenNames,
  clampLabel,
  displayName as composeDisplayName,
  givenNameFor,
  handoffDisplayName,
  managerName,
  sessionTitle,
  roleFor,
} from "./naming.mjs";

const KIND_LABELS = {
  session: "Orchestrator",
  child: "Worker",
  handoff: "Spec",
  review: "Review",
  "spec-review": "Spec review",
  escalation: "Escalation",
};

/** Sprite ids from index.html; the list, drawer and legend reuse them. */
const KIND_GLYPHS = {
  session: "manager",
  child: "agent",
  handoff: "spec",
  review: "review",
  "spec-review": "folder",
  escalation: "escalation",
};

/** A person's role noun, or the noun for a non-person node. */
const KIND_ROLES = {
  session: "Manager",
  handoff: "Spec",
  review: "Review",
  "spec-review": "Gate",
  escalation: "Escalation",
};

const STATUS_LABELS = {
  running: "Running",
  completed: "Completed",
  blocked: "Blocked",
  failed: "Failed",
  closed: "Closed",
  pending: "Pending",
  paused: "Paused",
  approved: "Approved",
  rejected: "Rejected",
  revise: "Needs revision",
  draft: "Draft",
  ready: "Ready",
  collecting: "Collecting",
  resolved: "Resolved",
  connected: "Live",
  offline: "Offline",
};

export function kindLabel(kind) {
  return KIND_LABELS[kind] || safeText(kind || "Node", 40);
}

export function kindGlyph(kind) {
  return KIND_GLYPHS[kind] || "node";
}

/** The role noun shown under a node title: a person's job, or the node's kind. */
export function nodeRole(node) {
  const kind = String(node?.kind || "child");
  if (kind === "child") return roleFor(node);
  return KIND_ROLES[kind] || kindLabel(kind);
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || safeText(status || "unknown", 40);
}

export function statusSlug(status) {
  return String(status || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Stable, DOT-safe element id for an entity key. */
export function dotIdFor(prefix, key) {
  return `${prefix}${fnv1a(`${prefix}:${key}`).toString(36)}`;
}

function byText(a, b) {
  return String(a).localeCompare(String(b));
}

function uniqueEdges(edges) {
  const seen = new Set();
  const result = [];
  for (const edge of edges) {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
    if (seen.has(key) || edge.from === edge.to) continue;
    seen.add(key);
    result.push(edge);
  }
  result.sort((a, b) => byText(a.from, b.from) || byText(a.to, b.to) || byText(a.kind, b.kind));
  return result;
}

function edgeIdFor(edge, used) {
  let id = dotIdFor("e", `${edge.from}->${edge.to}:${edge.kind}`);
  let suffix = 2;
  while (used.has(id)) id = dotIdFor("e", `${edge.from}->${edge.to}:${edge.kind}#${suffix++}`);
  used.add(id);
  return id;
}

function artifactVersion(summary) {
  return Number(summary?.version) || 0;
}

function sortArtifacts(summaries) {
  return [...summaries].sort((a, b) => {
    const bTime = Date.parse(b.updatedAt || b.createdAt || "") || 0;
    const aTime = Date.parse(a.updatedAt || a.createdAt || "") || 0;
    return bTime - aTime || byText(a.id, b.id);
  });
}

const ATTENTION_STATUSES = new Set(["blocked", "failed", "revise", "rejected"]);
const FINISHED_STATUSES = new Set(["completed", "closed", "approved", "resolved", "reviewed"]);

/** A node needs a human decision: a pending ping, a stuck status or an escalation. */
function needsAttentionFor(node) {
  if (!node) return false;
  if (node.kind === "escalation") return true;
  if (ATTENTION_STATUSES.has(String(node.status || ""))) return true;
  return Boolean(node.raw?.pendingPing);
}

/**
 * Derived status of a handoff from the workers attached to it by `handoffId`.
 * Order matters: one blocked/failed worker outranks any running worker.
 * @param {string} handoffId
 * @param {any[]} children
 */
export function handoffStatusFor(handoffId, children) {
  const workers = (Array.isArray(children) ? children : []).filter(
    (child) => child && handoffId != null && child.handoffId === handoffId,
  );
  if (workers.length === 0) return "pending";
  const statuses = workers.map((child) => String(child.status || "running"));
  if (statuses.some((status) => status === "blocked" || status === "failed")) return "blocked";
  if (statuses.some((status) => status === "running")) return "running";
  if (statuses.every((status) => status === "completed" || status === "closed")) return "completed";
  return "pending";
}

/**
 * @param {any} view DashboardSessionView
 * @param {{hideCompleted?: boolean}} options
 */
export function projectGraph(view, options = {}) {
  const hideCompleted = Boolean(options.hideCompleted);
  const session = view?.session || { id: "unknown", name: "Session", project: "", mode: "" };
  const orchestrator = view?.orchestrator || {};
  const children = Array.isArray(orchestrator.children) ? [...orchestrator.children] : [];
  const handoffs = Array.isArray(orchestrator.handoffs) ? [...orchestrator.handoffs] : [];
  const reviews = Array.isArray(orchestrator.reviews) ? [...orchestrator.reviews] : [];
  const escalations = Array.isArray(orchestrator.escalations) ? [...orchestrator.escalations] : [];
  const specReviews = Array.isArray(orchestrator.specReviews) ? [...orchestrator.specReviews] : [];
  const artifacts = Array.isArray(view?.artifacts) ? view.artifacts : [];

  children.sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0) || byText(a.id, b.id));
  handoffs.sort((a, b) => byText(a.id, b.id));
  reviews.sort((a, b) => byText(a.timestamp || "", b.timestamp || "") || byText(a.id, b.id));
  escalations.sort((a, b) => byText(a.id, b.id));
  specReviews.sort((a, b) => byText(a.id, b.id));

  const sessionNodeId = `session:${session.id}`;
  // Names are assigned once per projection from the sorted child ids: a refresh
  // cannot renumber anyone, and an explicit author name claims its slot first.
  const givenNames = assignGivenNames(children);
  const nodes = [];
  const pushNode = (node) => {
    const finalNode = {
      artifactIds: [],
      laneFiles: [],
      ...node,
    };
    finalNode.displayName = finalNode.displayName || finalNode.label;
    finalNode.role = finalNode.role || nodeRole(finalNode);
    finalNode.kindGlyph = finalNode.kindGlyph || kindGlyph(finalNode.kind);
    nodes.push(finalNode);
    return finalNode;
  };

  pushNode({
    id: sessionNodeId,
    entityId: session.id,
    kind: "session",
    label: managerName({ project: session.project, sessionName: session.name }),
    displayName: `${sessionTitle({ project: session.project, sessionName: session.name })} Manager`,
    sublabel: [session.project, session.mode].filter(Boolean).join(" · "),
    status: orchestrator.paused ? "paused" : "running",
    scope: undefined,
    raw: session,
  });

  const childNodeById = new Map();
  for (const child of children) {
    const givenName = givenNames.get(child.id) || givenNameFor(child.id);
    const fullName = composeDisplayName(
      { id: child.id, name: child.name, scope: child.scope, purpose: child.purpose, kind: "child" },
      { givenName, max: 60 },
    );
    const childNode = pushNode({
      id: `child:${child.id}`,
      entityId: child.id,
      kind: "child",
      label: clampLabel(fullName, 32),
      displayName: fullName,
      givenName,
      sublabel: [child.scope, child.purpose].filter(Boolean).join(" · "),
      status: String(child.status || "running"),
      scope: child.scope,
      laneFiles: Array.isArray(child.laneFiles) ? child.laneFiles : [],
      lastMilestoneFiles: Array.isArray(child.lastMilestoneFiles) ? child.lastMilestoneFiles : [],
      artifactIds: Array.isArray(child.artifactIds) ? child.artifactIds : [],
      raw: child,
    });
    childNodeById.set(child.id, childNode);
  }

  const childIds = new Set(children.map((child) => child.id));
  const referencedHandoffs = new Set(
    children.map((child) => child.handoffId).filter((id) => handoffs.some((handoff) => handoff.id === id)),
  );

  for (const handoff of handoffs) {
    // Workers are provenance-only (`child.handoffId`); scope never attaches one.
    // They ride along as drawer metadata and are never turned back into nodes, so
    // `hideCompleted` pruning below cannot be undone here.
    const workers = children
      .filter((child) => child.handoffId === handoff.id)
      .map((child) => childNodeById.get(child.id))
      .filter(Boolean);
    pushNode({
      id: `handoff:${handoff.id}`,
      entityId: handoff.id,
      kind: "handoff",
      label: handoffDisplayName(handoff),
      sublabel: safeText(handoff.goal || "", 80),
      status: handoffStatusFor(handoff.id, children),
      workers,
      scope: handoff.scope,
      raw: handoff,
    });
  }

  for (const review of reviews) {
    // A review is a verdict, not a person. Reuse the reviewer's given name only
    // when the review record names the child that produced it.
    const reviewerName = review.childId && givenNames.get(review.childId) ? givenNames.get(review.childId) : "";
    pushNode({
      id: `review:${review.id}`,
      entityId: review.id,
      kind: "review",
      label: composeDisplayName({ kind: "review", scope: review.scope, id: review.id }, { givenName: reviewerName }),
      sublabel: safeText(review.summary || "", 80),
      status: String(review.verdict || "reviewed"),
      scope: review.scope,
      raw: review,
    });
  }

  for (const specReview of specReviews) {
    pushNode({
      id: `spec-review:${specReview.id}`,
      entityId: specReview.id,
      kind: "spec-review",
      label: composeDisplayName({ kind: "spec-review", title: specReview.title, id: specReview.id }),
      sublabel: Array.isArray(specReview.reviewerIds) ? `${specReview.reviewerIds.length} reviewers` : "",
      status: String(specReview.status || "pending"),
      raw: specReview,
    });
  }

  for (const escalation of escalations) {
    pushNode({
      id: `escalation:${escalation.id}`,
      entityId: escalation.id,
      kind: "escalation",
      label: composeDisplayName({ kind: "escalation", scope: escalation.scope }),
      sublabel: safeText(escalation.question || "", 90),
      status: "blocked",
      scope: escalation.scope,
      raw: escalation,
    });
  }

  const edges = [];
  for (const child of children) {
    edges.push({ from: sessionNodeId, to: `child:${child.id}`, kind: "spawn" });
    if (child.handoffId && handoffs.some((handoff) => handoff.id === child.handoffId)) {
      edges.push({ from: `child:${child.id}`, to: `handoff:${child.handoffId}`, kind: "handoff" });
    }
    if (child.reviewRunId && specReviews.some((specReview) => specReview.id === child.reviewRunId)) {
      edges.push({ from: `child:${child.id}`, to: `spec-review:${child.reviewRunId}`, kind: "review" });
    }
    for (const superseded of Array.isArray(child.supersededIds) ? child.supersededIds : []) {
      if (childIds.has(superseded)) {
        edges.push({ from: `child:${child.id}`, to: `child:${superseded}`, kind: "supersedes" });
      }
    }
  }
  for (const handoff of handoffs) {
    if (!referencedHandoffs.has(handoff.id)) edges.push({ from: sessionNodeId, to: `handoff:${handoff.id}`, kind: "handoff" });
  }
  for (const review of reviews) {
    edges.push({ from: sessionNodeId, to: `review:${review.id}`, kind: "verdict" });
  }
  for (const specReview of specReviews) {
    const attached = children.some((child) => child.reviewRunId === specReview.id);
    if (!attached) edges.push({ from: sessionNodeId, to: `spec-review:${specReview.id}`, kind: "review" });
  }
  for (const escalation of escalations) {
    const owner = escalation.childId && childIds.has(escalation.childId) ? `child:${escalation.childId}` : sessionNodeId;
    edges.push({ from: owner, to: `escalation:${escalation.id}`, kind: "escalation" });
  }

  const counts = {
    children: children.length,
    running: children.filter((child) => child.status === "running").length,
    completed: children.filter((child) => child.status === "completed").length,
    blocked: children.filter((child) => child.status === "blocked").length,
    failed: children.filter((child) => child.status === "failed").length,
    closed: children.filter((child) => child.status === "closed").length,
    handoffs: handoffs.length,
    reviews: reviews.length,
    escalations: escalations.length,
    specReviews: specReviews.length,
    artifacts: artifacts.length,
  };

  // Associations are provenance-based only. An artifact's scope is deliberately
  // ignored here: scope can filter the catalog, never claim an owner.
  const associations = {};
  const addAssociation = (nodeId, summary) => {
    if (!summary || typeof summary.id !== "string") return;
    (associations[nodeId] ||= []).push(summary);
  };
  for (const node of nodes) {
    if (node.kind === "child") {
      for (const summary of artifacts) {
        if (summary.childId === node.entityId || node.artifactIds.includes(summary.id)) addAssociation(node.id, summary);
      }
    } else if (node.kind === "session") {
      for (const summary of artifacts) if (!summary.childId) addAssociation(node.id, summary);
    }
  }
  // A handoff inherits exactly what its own workers already own. Workers are the
  // full `child.handoffId` set, not the `hideCompleted`-pruned one, so hiding a
  // worker never changes what the drawer shows. Scope still never associates.
  for (const node of nodes) {
    if (node.kind !== "handoff" || node.workers.length === 0) continue;
    for (const worker of node.workers) {
      for (const summary of associations[worker.id] || []) addAssociation(node.id, summary);
    }
  }
  for (const [nodeId, list] of Object.entries(associations)) {
    const unique = new Map(list.map((summary) => [summary.id, summary]));
    associations[nodeId] = sortArtifacts(unique.values());
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (node) node.artifactIds = associations[nodeId].map((summary) => summary.id);
  }

  // Prune hidden completed/closed workers, then drop edges and orphaned nodes.
  let visibleNodes = nodes;
  if (hideCompleted) {
    const hidden = new Set(
      nodes.filter((node) => node.kind === "child" && (node.status === "completed" || node.status === "closed")).map((node) => node.id),
    );
    visibleNodes = nodes.filter((node) => !hidden.has(node.id));
  }
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  let visibleEdges = edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  if (hideCompleted) {
    const connected = new Set([sessionNodeId]);
    for (const edge of visibleEdges) {
      connected.add(edge.from);
      connected.add(edge.to);
    }
    visibleNodes = visibleNodes.filter((node) => connected.has(node.id));
    const connectedIds = new Set(visibleNodes.map((node) => node.id));
    visibleEdges = visibleEdges.filter((edge) => connectedIds.has(edge.from) && connectedIds.has(edge.to));
  }

  const usedNodeIds = new Set();
  for (const node of visibleNodes) {
    let id = dotIdFor("n", node.id);
    let suffix = 2;
    while (usedNodeIds.has(id)) id = dotIdFor("n", `${node.id}#${suffix++}`);
    usedNodeIds.add(id);
    node.dotId = id;
  }
  const usedEdgeIds = new Set();
  const unique = uniqueEdges(visibleEdges);
  for (const edge of unique) {
    edge.id = `${edge.from}->${edge.to}:${edge.kind}`;
    edge.dotId = edgeIdFor(edge, usedEdgeIds);
  }

  return {
    sessionNodeId,
    nodes: visibleNodes,
    edges: unique,
    counts,
    associations,
    hiddenCompleted: hideCompleted,
  };
}

export function topologySignature(graph) {
  const nodes = graph.nodes
    .map((node) => `${node.id}\u0001${node.dotId}\u0001${node.label}\u0001${node.sublabel || ""}`)
    .sort(byText)
    .join("\u0002");
  const edges = graph.edges.map((edge) => `${edge.from}\u0001${edge.to}\u0001${edge.kind}`).sort(byText).join("\u0002");
  return `${nodes}\u0003${edges}`;
}

const STYLE = {
  running: { fill: "#10261d", stroke: "#2f9e6f", font: "#dcf7e9" },
  completed: { fill: "#1a2230", stroke: "#4d5f78", font: "#cbd6e4" },
  closed: { fill: "#191c23", stroke: "#39414f", font: "#9aa5b4" },
  blocked: { fill: "#31250f", stroke: "#c58a2b", font: "#f7e6c6" },
  failed: { fill: "#31151a", stroke: "#c4495a", font: "#f9d9de" },
  pending: { fill: "#1d2030", stroke: "#5b648a", font: "#dfe3f4" },
  paused: { fill: "#251f33", stroke: "#8b6fd1", font: "#e8e1fb" },
  approved: { fill: "#10261d", stroke: "#2f9e6f", font: "#dcf7e9" },
  rejected: { fill: "#31151a", stroke: "#c4495a", font: "#f9d9de" },
  revise: { fill: "#31250f", stroke: "#c58a2b", font: "#f7e6c6" },
  ready: { fill: "#10261d", stroke: "#2f9e6f", font: "#dcf7e9" },
};

export function styleForStatus(status) {
  return STYLE[status] || STYLE.pending;
}

/**
 * Shape/style per node kind: the primary, colour-blind-safe encoding.
 * A spec is a document (`note`, dashed), a review is a verdict (`hexagon`), a
 * spec review is a gate (`folder`), an escalation is a stop sign (`octagon`),
 * the manager is the root plate (`box3d`) and a worker is a person (`box`).
 */
export const NODE_KIND_STYLE = Object.freeze({
  session: { shape: "box3d", style: "filled", penwidth: "1.8", margin: "0.18,0.09" },
  child: { shape: "box", style: "rounded,filled", penwidth: "1.3", margin: "0.14,0.07" },
  handoff: { shape: "note", style: "dashed,filled", penwidth: "1.1", margin: "0.16,0.09" },
  review: { shape: "hexagon", style: "filled", penwidth: "1.3", margin: "0.2,0.08" },
  "spec-review": { shape: "folder", style: "filled", penwidth: "1.2", margin: "0.18,0.08" },
  escalation: { shape: "octagon", style: "dashed,filled", penwidth: "1.4", margin: "0.18,0.08" },
});

/** Kind paint wins where the kind, not the state, is the message. */
const KIND_PAINT = {
  session: { fill: "#142033", stroke: "#5b8def", font: "#e3ecff" },
  handoff: { fill: "#1b2230", stroke: "#8b98ad", font: "#dbe3ef" },
  escalation: { fill: "#2c240f", stroke: "#c58a2b", font: "#f7e6c6" },
};

/**
 * The paint for one node: workers and reviews follow status, while a spec keeps
 * its neutral paper tone and an escalation stays amber whatever the state.
 */
export function paintForNode(node) {
  const kind = typeof node === "string" ? node : node?.kind;
  const status = typeof node === "string" ? arguments[1] : node?.status;
  return KIND_PAINT[kind] || styleForStatus(status);
}

/** Edge paint per kind: solid spawn, dotted delivery, hairline verdict, amber stop. */
export const EDGE_KIND_STYLE = Object.freeze({
  spawn: { color: "#42506a", penwidth: "1.1", style: "solid", tooltip: "spawn" },
  handoff: { color: "#8b98ad", penwidth: "1.2", style: "dotted", arrowhead: "normal", tooltip: "delivers" },
  review: { color: "#7f8fb3", penwidth: "1.0", style: "solid", tooltip: "review" },
  verdict: { color: "#6f7b92", penwidth: "0.9", style: "solid", tooltip: "verdict" },
  escalation: { color: "#c58a2b", penwidth: "1.3", style: "dashed", tooltip: "escalation" },
  supersedes: { color: "#5a6478", penwidth: "1.0", style: "dotted", tooltip: "supersedes" },
});

/**
 * Build a deterministic DOT document for a projected graph.
 *
 * Pure function of the projected graph: same nodes/edges/kinds/statuses in,
 * byte-identical DOT out, so a relayout is only ever triggered by topology.
 * No animation state is ever written here.
 * @param {{nodes: any[], edges: any[]}} graph
 */
export function buildDot(graph, options = {}) {
  const dotIds = new Map(graph.nodes.map((node) => [node.id, node.dotId]));
  const graphAttributes = [
    'rankdir="TB"',
    'splines="spline"',
    'pad="0.35"',
    'nodesep="0.5"',
    'ranksep="0.6"',
    'bgcolor="transparent"',
    'fontsize="10"',
    'fontcolor="#7c8899"',
  ];
  // The graph frame carries its own caption row, so a DOT title is opt-in only.
  if (options.title) graphAttributes.push(`label="${escapeDotString(options.title, 80)}"`, 'labelloc="t"');
  const lines = [
    "digraph dashboard {",
    `  graph [${graphAttributes.join(", ")}];`,
    '  node [shape="box", style="rounded,filled", fontname="ui-sans-serif, system-ui, sans-serif", fontsize="11", margin="0.14,0.07", penwidth="1.2"];',
    '  edge [color="#42506a", arrowsize="0.7", penwidth="1.1"];',
  ];
  for (const node of graph.nodes) {
    const paint = paintForNode(node);
    const kindStyle = NODE_KIND_STYLE[node.kind] || NODE_KIND_STYLE.child;
    const classes = ["node", `node-${node.kind}`, `kind-${node.kind}`, `status-${statusSlug(node.status)}`].join(" ");
    const title = `${node.displayName || node.label} — ${kindLabel(node.kind)}, ${statusLabel(node.status)}`;
    const attributes = [
      `id="${node.dotId}"`,
      `class="${classes}"`,
      `label="${escapeDotString(node.label, 56)}"`,
      `tooltip="${escapeDotString(title, 120)}"`,
      `fillcolor="${paint.fill}"`,
      `color="${paint.stroke}"`,
      `fontcolor="${paint.font}"`,
      `shape="${kindStyle.shape}"`,
      `style="${kindStyle.style}"`,
      `penwidth="${kindStyle.penwidth}"`,
      `margin="${kindStyle.margin}"`,
    ];
    lines.push(`  ${node.dotId} [${attributes.join(", ")}];`);
  }
  for (const edge of graph.edges) {
    const kindStyle = EDGE_KIND_STYLE[edge.kind] || EDGE_KIND_STYLE.spawn;
    const classes = ["edge", `edge-${edge.kind}`].join(" ");
    const attributes = [
      `id="${edge.dotId}"`,
      `class="${classes}"`,
      `tooltip="${escapeDotString(kindStyle.tooltip, 40)}"`,
      `color="${kindStyle.color}"`,
      `penwidth="${kindStyle.penwidth}"`,
      `style="${kindStyle.style}"`,
    ];
    if (kindStyle.arrowhead) attributes.push(`arrowhead="${kindStyle.arrowhead}"`);
    lines.push(`  ${dotIds.get(edge.from)} -> ${dotIds.get(edge.to)} [${attributes.join(", ")}];`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** Flat, UI-friendly description of one node (all values are plain strings). */
export function describeNode(node, { artifacts = [] } = {}) {
  if (!node) return null;
  const raw = node.raw || {};
  return {
    id: node.id,
    entityId: node.entityId,
    kind: node.kind,
    kindLabel: kindLabel(node.kind),
    kindGlyph: node.kindGlyph || kindGlyph(node.kind),
    label: node.label,
    displayName: node.displayName || node.label,
    role: node.role || nodeRole(node),
    givenName: node.givenName || "",
    status: node.status,
    statusLabel: statusLabel(node.status),
    scope: node.scope || "",
    goal: node.kind === "handoff" ? safeText(raw.goal || "", 4000) : "",
    acceptanceCriteria: node.kind === "handoff" && Array.isArray(raw.acceptanceCriteria)
      ? raw.acceptanceCriteria.map((criterion) => safeText(criterion, 400)).filter(Boolean).slice(0, 50)
      : [],
    workers: Array.isArray(node.workers) ? [...node.workers] : [],
    needsAttention: needsAttentionFor(node),
    task: safeText(raw.task || raw.goal || node.sublabel || "", 400),
    laneFiles: [...(node.laneFiles || [])],
    lastMilestoneFiles: [...(node.lastMilestoneFiles || [])],
    handoffId: raw.handoffId || "",
    reviewRunId: raw.reviewRunId || "",
    reviewLens: raw.reviewLens || "",
    supersededIds: Array.isArray(raw.supersededIds) ? [...raw.supersededIds] : [],
    pendingPing: Boolean(raw.pendingPing),
    startedAt: raw.startedAt || null,
    updatedAt: raw.updatedAt || null,
    budgetMs: raw.budgetMs || null,
    lastTokens: raw.lastTokens || null,
    lastContextWindow: raw.lastContextWindow || null,
    closeReason: raw.closeReason || "",
    question: node.kind === "escalation" ? safeText(raw.question || "", 400) : "",
    summary: node.kind === "review" ? safeText(raw.summary || "", 600) : "",
    artifactIds: [...(node.artifactIds || [])],
    artifacts: sortArtifacts(artifacts).map((summary) => ({
      id: summary.id,
      title: safeText(summary.title || summary.id, 120),
      type: summary.type || "",
      version: artifactVersion(summary),
      updatedAt: summary.updatedAt || "",
    })),
  };
}

/**
 * Split visible graph nodes into the three work groups, preserving graph order.
 * Session nodes are structural and never listed as work.
 */
export function groupWork(graph) {
  const grouped = { attention: [], active: [], finished: [] };
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    if (!node || node.kind === "session") continue;
    if (needsAttentionFor(node)) grouped.attention.push(node);
    else if (FINISHED_STATUSES.has(String(node.status || ""))) grouped.finished.push(node);
    else grouped.active.push(node);
  }
  return grouped;
}

/** Counts that always agree with `groupWork()`; `total` excludes session nodes. */
export function workCounts(graph) {
  const grouped = groupWork(graph);
  const attention = grouped.attention.length;
  const active = grouped.active.length;
  const finished = grouped.finished.length;
  return { attention, active, finished, total: attention + active + finished };
}

/** Case-insensitive catalog filtering over id/title/type/tags/scope/childId. */
export function filterArtifacts(summaries, query) {
  const tokens = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  const list = Array.isArray(summaries) ? summaries : [];
  const filtered = tokens.length === 0
    ? [...list]
    : list.filter((summary) => {
      const haystack = [
        summary.id,
        summary.title,
        summary.type,
        summary.scope,
        summary.childId,
        ...(Array.isArray(summary.tags) ? summary.tags : []),
      ].filter(Boolean).join(" ").toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
  return sortArtifacts(filtered);
}
