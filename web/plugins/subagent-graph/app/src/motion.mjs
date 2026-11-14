/**
 * Motion planning — the browser decides *when* to animate; CSS decides *how*.
 *
 * Everything here is a pure function of two projected graphs, so the plan can be
 * tested in Node without a DOM, a clock or a matchMedia. The result is applied by
 * adding/removing CSS classes (see `style.css`), never by inline styles or SMIL,
 * which keeps `style-src 'self'` and the SVG sanitizer untouched.
 *
 * `topologySignature()` is deliberately not involved: animation classes are
 * applied after render and never enter `buildDot()`, so a status update still
 * skips Graphviz entirely.
 */

/** Only this many nodes get a staggered entry; the rest appear together. */
const MAX_STAGGER = 12;

function emptyPlan(reducedMotion) {
  return {
    relayout: false,
    entering: [],
    edgesToDraw: [],
    updated: [],
    instants: [],
    reducedMotion,
  };
}

function statusMap(graph) {
  const map = new Map();
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    if (!node || typeof node.id !== "string") continue;
    map.set(node.id, String(node.status ?? ""));
  }
  return map;
}

/**
 * Decide what should animate between two projections.
 *
 * @param {any} prev the graph currently rendered (null on first paint)
 * @param {any} next the newly projected graph
 * @param {{reducedMotion?: boolean}} [options]
 * @returns {{
 *   relayout: boolean,
 *   entering: string[],
 *   edgesToDraw: string[],
 *   updated: string[],
 *   instants: string[],
 *   reducedMotion: boolean,
 * }}
 */
export function planGraphMotion(prev, next, options = {}) {
  const reducedMotion = Boolean(options.reducedMotion);
  if (reducedMotion) {
    // Under prefers-reduced-motion every transition is replaced by an instant
    // state change: no entering classes, no draw-in, no viewBox tween.
    return emptyPlan(true);
  }
  if (!next || !Array.isArray(next.nodes)) return emptyPlan(false);

  const previous = prev && Array.isArray(prev.nodes) ? prev : null;
  const relayout = !previous || (prev?.signature != null && next.signature != null && prev.signature !== next.signature);

  if (!previous) {
    // First paint: stagger the first screenful, draw every edge in once.
    const entering = next.nodes.slice(0, MAX_STAGGER).map((node) => node.id);
    return {
      relayout: true,
      entering,
      edgesToDraw: next.edges.map((edge) => edge.id),
      updated: [],
      instants: [],
      reducedMotion: false,
    };
  }

  const seen = new Set(previous.nodes.map((node) => node.id));
  const entering = next.nodes.filter((node) => !seen.has(node.id)).slice(0, MAX_STAGGER).map((node) => node.id);
  const previousEdges = new Set((previous.edges || []).map((edge) => edge.id));
  const edgesToDraw = next.edges.filter((edge) => !previousEdges.has(edge.id)).map((edge) => edge.id);

  // In-place status updates: flash the node for 600ms instead of re-rendering.
  const before = statusMap(previous);
  const updated = [];
  for (const node of next.nodes) {
    const previousStatus = before.get(node.id);
    if (previousStatus === undefined || previousStatus === String(node.status ?? "")) continue;
    updated.push(node.id);
  }

  return { relayout, entering, edgesToDraw, updated, instants: [], reducedMotion: false };
}

/** Stagger delay for the nth entering node, capped so a burst stays snappy. */
export function staggerDelayMs(index, step = 18) {
  const position = Math.min(Math.max(0, Number(index) || 0), MAX_STAGGER - 1);
  return position * step;
}

/** Durations shared with CSS; exported so tests and CSS agree on the budget. */
export const MOTION = Object.freeze({
  relayoutMs: 320,
  entryMs: 220,
  staggerStepMs: 18,
  maxStagger: MAX_STAGGER,
  edgeDrawMs: 360,
  statusFlashMs: 600,
  ambientMs: 2400,
  activeEdgeMs: 1800,
});

/** True when the browser asks for reduced motion; safe in a non-DOM host. */
export function prefersReducedMotion(host = globalThis) {
  try {
    return Boolean(host?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  } catch {
    return false;
  }
}
