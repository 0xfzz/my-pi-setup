export interface GraphNode {
  id: string;
  dotId: string;
  entityId: string;
  kind: string;
  label: string;
  /** Full composed name (`Bima · Skeleton Builder`), for tooltip/aria/drawer. */
  displayName?: string;
  /** The assigned given name for a worker; empty for non-person nodes. */
  givenName?: string;
  /** A person's role noun, or the node's kind noun. */
  role?: string;
  /** Sprite id from index.html (`agent`, `spec`, `review`, `manager`, …). */
  kindGlyph?: string;
  sublabel?: string;
  status: string;
  scope?: string;
  laneFiles: string[];
  lastMilestoneFiles?: string[];
  artifactIds: string[];
  /** Workers attached to a handoff by provenance (`child.handoffId`). */
  workers?: GraphNode[];
  raw?: Record<string, any>;
}

export interface GraphEdge {
  id: string;
  dotId: string;
  from: string;
  to: string;
  kind: string;
}

export interface GraphCounts {
  children: number;
  running: number;
  completed: number;
  blocked: number;
  failed: number;
  closed: number;
  handoffs: number;
  reviews: number;
  escalations: number;
  specReviews: number;
  artifacts: number;
}

export interface ProjectedGraph {
  sessionNodeId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: GraphCounts;
  associations: Record<string, any[]>;
  hiddenCompleted: boolean;
}

export interface NodeDescription {
  id: string;
  entityId: string;
  kind: string;
  kindLabel: string;
  /** Sprite id for the kind icon. */
  kindGlyph: string;
  label: string;
  /** Full composed label; identical to `label` for short names. */
  displayName: string;
  /** Role noun: `Skeleton Builder`'s role is `Builder`; `Manager` for the root. */
  role: string;
  /** Assigned given name, empty for documents and verdicts. */
  givenName: string;
  status: string;
  statusLabel: string;
  scope: string;
  /** Full handoff goal; empty for non-handoff nodes. */
  goal: string;
  /** Handoff acceptance criteria (capped/sanitized by the runtime). */
  acceptanceCriteria: string[];
  /** Projected child nodes attached to this handoff, in graph order. */
  workers: GraphNode[];
  /** True when the node needs a human decision (ping, stuck status, escalation). */
  needsAttention: boolean;
  task: string;
  laneFiles: string[];
  lastMilestoneFiles: string[];
  handoffId: string;
  reviewRunId: string;
  reviewLens: string;
  supersededIds: string[];
  pendingPing: boolean;
  startedAt: number | null;
  updatedAt: string | null;
  budgetMs: number | null;
  lastTokens: number | null;
  lastContextWindow: number | null;
  closeReason: string;
  question: string;
  summary: string;
  artifactIds: string[];
  artifacts: Array<{ id: string; title: string; type: string; version: number; updatedAt: string }>;
}

export interface WorkGroups {
  attention: GraphNode[];
  active: GraphNode[];
  finished: GraphNode[];
}

export interface WorkCounts {
  attention: number;
  active: number;
  finished: number;
  total: number;
}

export function kindLabel(kind: string): string;
export function kindGlyph(kind: string): string;
export function nodeRole(node: any): string;
export function paintForNode(node: any): { fill: string; stroke: string; font: string };
export const NODE_KIND_STYLE: Readonly<Record<string, { shape: string; style: string; penwidth: string; margin: string }>>;
export const EDGE_KIND_STYLE: Readonly<Record<string, { color: string; penwidth: string; style: string; tooltip: string; arrowhead?: string }>>;
export function statusLabel(status: string): string;
export function statusSlug(status: string): string;
export function dotIdFor(prefix: string, key: string): string;
export function projectGraph(view: any, options?: { hideCompleted?: boolean }): ProjectedGraph;
export function handoffStatusFor(handoffId: string | null, children: any[]): "pending" | "blocked" | "running" | "completed";
export function topologySignature(graph: ProjectedGraph): string;
export function styleForStatus(status: string): { fill: string; stroke: string; font: string };
export function buildDot(graph: ProjectedGraph, options?: { title?: string }): string;
export function describeNode(node: GraphNode | null | undefined, options?: { artifacts?: any[] }): NodeDescription | null;
export function groupWork(graph: ProjectedGraph): WorkGroups;
export function workCounts(graph: ProjectedGraph): WorkCounts;
export function filterArtifacts(summaries: any[], query?: string): any[];
