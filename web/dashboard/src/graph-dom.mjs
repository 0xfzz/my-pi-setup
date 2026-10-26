/**
 * DOM decoration for the sanitized Graphviz SVG: stable data ids, accessible
 * labels, keyboard focus, a generous click target and selection state. Kept
 * separate so tests can run it against a jsdom document.
 */

import { kindLabel, nodeRole, paintForNode, statusLabel, statusSlug } from "./graph.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";
const HIT_PADDING = 10;

function kindClasses(node) {
  return ["graph-node", `node-${node.kind}`, `kind-${node.kind}`, `status-${statusSlug(node.status)}`];
}

function nodeTitle(element, node) {
  const title = Array.from(element.children || []).find((child) => String(child.localName).toLowerCase() === "title");
  return title || null;
}

function localName(element) {
  return String(element?.localName || "").toLowerCase();
}

function isHitArea(element) {
  return Boolean(element?.classList?.contains("node-hit"));
}

function round(value) {
  return Number(Number(value).toFixed(2));
}

/** Union of the drawn child shapes, ignoring the hit area we add ourselves. */
function childBoxes(element) {
  const boxes = [];
  for (const child of Array.from(element.children || [])) {
    if (isHitArea(child) || localName(child) === "title") continue;
    // Graphviz can wrap the polygon/label in another <g>; recurse to reach it.
    if (localName(child) === "g") {
      const nested = childBoxes(child);
      if (nested) boxes.push(nested);
      continue;
    }
    let box = null;
    try {
      box = typeof child.getBBox === "function" ? child.getBBox() : null;
    } catch {
      box = null;
    }
    if (box && Number.isFinite(box.width) && Number.isFinite(box.height)) {
      boxes.push({ x: box.x, y: box.y, width: box.width, height: box.height });
      continue;
    }
    // jsdom has no layout: fall back to the geometry Graphviz wrote out.
    const fromAttributes = attributeBox(child);
    if (fromAttributes) boxes.push(fromAttributes);
  }
  if (boxes.length === 0) return null;
  let box = { ...boxes[0] };
  for (const next of boxes.slice(1)) {
    const minX = Math.min(box.x, next.x);
    const minY = Math.min(box.y, next.y);
    const maxX = Math.max(box.x + box.width, next.x + next.width);
    const maxY = Math.max(box.y + box.height, next.y + next.height);
    box = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  return box;
}

function attributeBox(child) {
  const tag = localName(child);
  if (tag === "rect") {
    const width = Number(child.getAttribute("width"));
    const height = Number(child.getAttribute("height"));
    if (!Number.isFinite(width) || !Number.isFinite(height) || (!width && !height)) return null;
    return { x: Number(child.getAttribute("x")) || 0, y: Number(child.getAttribute("y")) || 0, width, height };
  }
  if (tag === "ellipse" || tag === "circle") {
    const rx = tag === "circle" ? Number(child.getAttribute("r")) : Number(child.getAttribute("rx"));
    const ry = tag === "circle" ? Number(child.getAttribute("r")) : Number(child.getAttribute("ry"));
    if (!Number.isFinite(rx) || !Number.isFinite(ry) || (!rx && !ry)) return null;
    const cx = Number(child.getAttribute("cx")) || 0;
    const cy = Number(child.getAttribute("cy")) || 0;
    return { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 };
  }
  if (tag === "polygon" || tag === "polyline") {
    const points = String(child.getAttribute("points") || "")
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split(",").map(Number))
      .filter((pair) => pair.length === 2 && pair.every(Number.isFinite));
    if (points.length === 0) return null;
    return boxFromPoints(points);
  }
  if (tag === "path") {
    // Graphviz rounded boxes are absolute C/L paths: every number is an x or y.
    const numbers = String(child.getAttribute("d") || "").match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
    const points = [];
    for (let index = 0; index + 1 < numbers.length; index += 2) {
      points.push([Number(numbers[index]), Number(numbers[index + 1])]);
    }
    if (points.length === 0) return null;
    return boxFromPoints(points);
  }
  if (tag === "text") {
    const x = Number(child.getAttribute("x"));
    const y = Number(child.getAttribute("y"));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, width: 0, height: 0 };
  }
  return null;
}

function boxFromPoints(points) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/**
 * Add (or refresh) a transparent rect that covers the node plus padding, so the
 * whole node is an easy pointer target without shrinking the visible shape.
 */
function ensureHitArea(element) {
  let hit = Array.from(element.children || []).find(isHitArea) || null;
  if (!hit) {
    hit = element.ownerDocument.createElementNS(SVG_NS, "rect");
    hit.setAttribute("class", "node-hit");
    hit.setAttribute("fill", "transparent");
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("aria-hidden", "true");
    hit.setAttribute("focusable", "false");
    element.append(hit);
  }
  const box = childBoxes(element);
  if (!box) return hit;
  hit.setAttribute("x", String(round(box.x - HIT_PADDING)));
  hit.setAttribute("y", String(round(box.y - HIT_PADDING)));
  hit.setAttribute("width", String(round(box.width + HIT_PADDING * 2)));
  hit.setAttribute("height", String(round(box.height + HIT_PADDING * 2)));
  return hit;
}

/**
 * Repaint a node for its current status.
 *
 * Graphviz bakes `fillcolor`/`color`/`fontcolor` into the SVG as attributes, and
 * the stylesheet has no `.graph-node.status-*` rule. Adding only the status class
 * on a status-only update therefore left the old paint in place: a child that had
 * completed kept the green "Working" fill of the snapshot that first drew it, so
 * the graph showed work in progress for a pane that was already closed.
 */
function repaintStatus(element, node) {
  const style = paintForNode(node);
  for (const child of Array.from(element.children || [])) {
    const name = localName(child);
    if (name === "title" || isHitArea(child)) continue;
    if (name === "g") {
      repaintStatus(child, node);
      continue;
    }
    if (name === "text" || name === "tspan") {
      child.setAttribute("fill", style.font);
      continue;
    }
    const fill = child.getAttribute("fill");
    if (fill && fill !== "none" && fill !== "transparent") child.setAttribute("fill", style.fill);
    const stroke = child.getAttribute("stroke");
    if (stroke && stroke !== "none") child.setAttribute("stroke", style.stroke);
  }
}

export function updateNodeElement(element, node) {
  for (const className of [...element.classList]) {
    if (className.startsWith("status-") || className.startsWith("node-") || className.startsWith("kind-")) {
      element.classList.remove(className);
    }
  }
  for (const className of kindClasses(node)) element.classList.add(className);
  element.setAttribute("data-node-kind", node.kind);
  repaintStatus(element, node);
  // The accessible label names the kind in words, so the shape is never the only
  // signal: "Bima · Skeleton Builder — Worker, running. Open details."
  const label = `${node.displayName || node.label} — ${kindLabel(node.kind)}, ${statusLabel(node.status)}. Open details.`;
  element.setAttribute("aria-label", label);
  element.setAttribute("role", "button");
  element.setAttribute("tabindex", "0");
  ensureHitArea(element);
  const text = `${node.displayName || node.label} — ${kindLabel(node.kind)} · ${statusLabel(node.status)}`;
  let title = nodeTitle(element, node);
  if (!title) {
    title = element.ownerDocument.createElementNS(SVG_NS, "title");
    element.prepend(title);
  }
  title.textContent = text;
}

/**
 * @param {SVGElement} svg sanitized Graphviz root
 * @param {any} graph projected graph
 * @param {Document} doc
 * @returns {Map<string, Element>} node id -> svg group
 */
/**
 * Keep the "alive" classes in sync with the current statuses.
 *
 * A running worker gets `is-live`; an edge touching a running worker gets
 * `is-active-edge` — except a delivery edge, which stays a static document
 * edge. These classes are applied after rendering and never enter buildDot(),
 * so the topology signature (and relayout decision) stays animation-independent.
 */
export function applyActivityClasses(svg, graph, { motion = true } = {}) {
  if (!svg) return;
  const runningIds = new Set(
    (graph?.nodes || [])
      .filter((node) => node.kind === "child" && String(node.status) === "running")
      .map((node) => node.id),
  );
  for (const node of graph?.nodes || []) {
    const element = svg.querySelector(`[data-node-id="${node.id.replace(/"/g, '\\"')}"]`);
    // Under prefers-reduced-motion the ambient classes are not applied at all,
    // so the graph is static by construction, not only by a CSS override.
    element?.classList.toggle("is-live", motion && runningIds.has(node.id));
  }
  for (const edge of graph?.edges || []) {
    const element = svg.querySelector(`[id="${edge.dotId}"]`);
    if (!element) continue;
    const active = motion && edge.kind !== "handoff" && (runningIds.has(edge.from) || runningIds.has(edge.to));
    element.classList.toggle("is-active-edge", active);
  }
}

export function decorateGraphSvg(svg, graph, doc = svg.ownerDocument, options = {}) {
  svg.classList.add("graph-svg");
  svg.setAttribute("role", "group");
  svg.setAttribute("focusable", "true");
  svg.setAttribute("tabindex", "0");
  svg.setAttribute(
    "aria-label",
    `Workflow graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges. Use arrow keys to pan, plus and minus to zoom, 0 to fit.`,
  );
  const elements = new Map();
  for (const node of graph.nodes) {
    const element = svg.querySelector(`[id="${node.dotId}"]`);
    if (!element) continue;
    element.setAttribute("data-node-id", node.id);
    element.setAttribute("data-node-kind", node.kind);
    updateNodeElement(element, node);
    elements.set(node.id, element);
  }
  for (const edge of graph.edges) {
    const element = svg.querySelector(`[id="${edge.dotId}"]`);
    if (!element) continue;
    element.classList.add("graph-edge", `edge-${edge.kind}`);
    element.setAttribute("data-edge-id", edge.id);
  }
  applyActivityClasses(svg, graph, options);
  return elements;
}

export function updateGraphSvg(svg, graph, options = {}) {
  if (!svg) return false;
  for (const node of graph.nodes) {
    const element = svg.querySelector(`[data-node-id="${node.id.replace(/"/g, '\\"')}"]`);
    if (!element) return false;
    updateNodeElement(element, node);
  }
  applyActivityClasses(svg, graph, options);
  return true;
}

export function selectGraphNode(svg, nodeId) {
  if (!svg) return;
  for (const element of svg.querySelectorAll(".graph-node")) {
    const selected = element.getAttribute("data-node-id") === nodeId;
    element.classList.toggle("is-selected", selected);
    if (selected) element.setAttribute("aria-current", "true");
    else element.removeAttribute("aria-current");
  }
}

export function graphNodeFromEvent(target) {
  const element = target?.closest?.("g.graph-node");
  return element?.getAttribute("data-node-id") || null;
}
