/**
 * Dashboard browser entry point.
 *
 * Data flow: GET /api/sessions -> GET /api/session -> user selection; SSE
 * `changed` messages trigger one coalesced refresh. Work items are browsed as a
 * list or a graph; both open the same detail drawer, which is an overlay and
 * never changes the active tab. Everything rendered from untrusted data goes
 * through textContent or the sanitizers in sanitize.mjs.
 */

import DOMPurify from "dompurify";
import { marked } from "marked";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import markdown from "highlight.js/lib/languages/markdown";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import yaml from "highlight.js/lib/languages/yaml";

import { createApi, createChangeCoalescer, parseChangeEvent } from "./api.mjs";
import { renderDot } from "./graphviz.mjs";
import {
  buildDot,
  describeNode,
  filterArtifacts,
  groupWork,
  kindGlyph,
  kindLabel,
  projectGraph,
  statusLabel,
  statusSlug,
  topologySignature,
  workCounts,
} from "./graph.mjs";
import { sessionTitle } from "./naming.mjs";
import { MOTION, planGraphMotion, staggerDelayMs } from "./motion.mjs";
import { decorateGraphSvg, graphNodeFromEvent, selectGraphNode, updateGraphSvg } from "./graph-dom.mjs";
import { createPanZoom } from "./panzoom.mjs";
import { renderMarkdownSafe, sanitizeSvgMarkup, safeText } from "./sanitize.mjs";
import * as S from "./state.mjs";

for (const [name, language] of Object.entries({ javascript, typescript, json, bash, python, markdown, xml, css, yaml })) {
  hljs.registerLanguage(name, language);
}
hljs.registerAliases(["js", "jsx", "mjs", "cjs", "node"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx", "mts", "cts"], { languageName: "typescript" });
hljs.registerAliases(["sh", "shell", "zsh", "console"], { languageName: "bash" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["md"], { languageName: "markdown" });
hljs.registerAliases(["html", "svg", "xhtml"], { languageName: "xml" });
hljs.registerAliases(["yml"], { languageName: "yaml" });

const TABS = ["work", "artifacts"];
const LEGEND_STATUS = [
  { status: "running", label: "Working" },
  { status: "completed", label: "Done" },
  { status: "blocked", label: "Needs attention" },
];
const LEGEND_NODES = [
  { kind: "session", label: "Orchestrator" },
  { kind: "child", label: "Worker" },
  { kind: "handoff", label: "Spec (handoff)" },
  { kind: "review", label: "Review" },
  { kind: "spec-review", label: "Spec review" },
  { kind: "escalation", label: "Escalation" },
];
const LEGEND_EDGES = [
  { kind: "spawn", label: "spawn" },
  { kind: "handoff", label: "delivers" },
  { kind: "verdict", label: "verdict" },
  { kind: "escalation", label: "escalation" },
];
const COPY_LABELS = {
  goal: "goal",
  criteria: "acceptance criteria",
  question: "question",
};
const MAX_FILES_SHOWN = 12;

const api = createApi();
let state = S.createState();
let lastArtifactRenderKey = null;

const graphState = {
  current: null,
  signature: null,
  svg: null,
  token: 0,
  panzoom: null,
  viewportTouched: false,
  sessionId: null,
  error: null,
  /** Last rendered projection: `{nodes, edges, signature}` for motion planning. */
  previous: null,
  /** requestAnimationFrame handle for the viewBox relayout tween. */
  viewTween: null,
  legendOpen: false,
};

const drawerState = {
  open: false,
  returnFocus: null,
};

const urlState = {
  ready: false,
  applying: false,
};
let pendingUrl = null;

const $ = (id) => document.getElementById(id);

function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function fmtRelative(value) {
  const timestamp = Number(value);
  if (!timestamp) return "";
  const diff = Date.now() - timestamp;
  if (diff < 0) return "just now";
  const seconds = Math.round(diff / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function relativeTime(value) {
  const timestamp = typeof value === "number" ? value : Date.parse(String(value || ""));
  return fmtRelative(timestamp);
}

function fmtDate(value) {
  const timestamp = typeof value === "number" ? value : Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp) || !timestamp) return "";
  return new Date(timestamp).toLocaleString();
}

function fmtDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "";
  const minutes = Math.floor(value / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Build an icon from the inline sprite in index.html.
 * Static markup only: no inline style, no network, CSP-safe.
 */
function icon(name, className = "icon") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}

function badge(status) {
  return el("span", { class: `badge status-${statusSlug(status)}`, text: statusLabel(status) });
}

/** Kind never reads as status: its own glyph, its own chip, its own palette. */
function kindChip(kind, label = kindLabel(kind)) {
  return el("span", { class: `kind-chip kind-${kind}`, title: `${label} node` }, [
    icon(kindGlyph(kind), "icon icon-kind"),
    el("span", { text: label }),
  ]);
}

function announce(message) {
  const live = $("live");
  if (!live) return;
  live.textContent = "";
  requestAnimationFrame(() => {
    live.textContent = message;
  });
}

function setState(next) {
  if (next === state) return;
  state = next;
  render();
}

/* ------------------------------------------------------------------ render */

function render() {
  graphState.current = state.session ? projectGraph(state.session, { hideCompleted: state.hideCompleted }) : null;
  renderChrome();
  renderSidebar();
  renderHeader();
  renderTabs();
  renderWorkPanel();
  if (state.tab === "artifacts") renderArtifacts();
  renderDrawer();
  syncUrl();
}

function renderChrome() {
  const error = $("error-banner");
  error.hidden = !state.error;
  $("error-text").textContent = state.error ? state.error.message : "";

  const notice = $("notice");
  notice.hidden = !state.notice;
  notice.textContent = state.notice || "";

  const live = state.connection === "live";
  const dot = $("connection-dot");
  dot.className = `connection-dot ${live ? "is-live" : "is-offline"}`;
  const pill = $("connection-pill");
  pill.classList.toggle("is-live", live);
  pill.classList.toggle("is-offline", !live);
  $("connection-label").textContent = live
    ? "live"
    : state.connection === "connecting"
      ? "connecting…"
      : "offline · reconnecting…";
}

function renderSidebar() {
  $("session-count").textContent = String(state.sessions.length);
  const list = $("session-list");
  const items = state.sessions.map((session) => {
    const active = session.id === state.selectedSessionId;
    const workers = session.workers || { running: 0, total: 0 };
    const label = sessionTitle({ project: session.project, sessionName: session.name });
    const subtitle = [session.mode, session.branchId ? `branch ${session.branchId}` : ""].filter(Boolean).join(" · ");
    return el(
      "button",
      {
        type: "button",
        class: `session-item${active ? " is-active" : ""}`,
        "data-session-id": session.id,
        "aria-current": active ? "page" : null,
        title: `${label} — ${session.project || "no project"}`,
      },
      [
        el("span", { class: "session-item-main" }, [
          el("span", { class: "session-name", text: label }),
          el("span", { class: "session-sub", text: subtitle || session.project || "unscoped" }),
        ]),
        el("span", { class: "session-item-side" }, [
          el("span", { class: `dot ${session.connected ? "is-live" : "is-offline"}`, "aria-hidden": "true" }),
          el("span", {
            class: "session-workers",
            text: `${workers.running}/${workers.total}`,
            title: `${workers.running} running of ${workers.total} workers`,
          }),
          el("span", { class: "session-seen", text: fmtRelative(session.lastSeen) }),
        ]),
      ],
    );
  });
  list.replaceChildren(...items);
  if (items.length === 0) list.append(el("p", { class: "empty-state small", text: "No sessions published yet." }));
}

/** Plain-language counts for the top bar; deliberately no count chips. */
function summarySentence(counts) {
  if (!state.session) return "Waiting for session data…";
  if (counts.total === 0) return "No work items yet";
  const parts = [`${counts.total} work ${counts.total === 1 ? "item" : "items"}`];
  if (counts.attention) parts.push(`${counts.attention} need attention`);
  if (counts.active) parts.push(`${counts.active} in progress`);
  if (counts.finished) parts.push(`${counts.finished} finished`);
  return parts.join(" · ");
}

function renderHeader() {
  const selected = state.sessions.find((session) => session.id === state.selectedSessionId);
  const view = state.session;
  // Session identity follows the current goal. Only the graph root gets the
  // Manager suffix; the project stays in secondary metadata.
  const label = sessionTitle({
    project: view?.session?.project || selected?.project,
    sessionName: view?.session?.name || selected?.name,
  });
  $("session-title").textContent = label || "Dashboard";
  $("session-title").title = label;

  const meta = [];
  if (view?.session?.project || selected?.project) meta.push(view?.session?.project || selected.project);
  if (view?.session?.mode || selected?.mode) meta.push(view?.session?.mode || selected.mode);
  if (view?.session?.branchId) meta.push(`branch ${view.session.branchId}`);
  meta.push(`${(view?.artifacts || []).length} artifacts`);
  if (state.updatedAt) meta.push(`updated ${fmtRelative(state.updatedAt)}`);
  $("session-meta").textContent = meta.join(" · ") || "Waiting for session data…";

  const counts = graphState.current ? workCounts(graphState.current) : { attention: 0, active: 0, finished: 0, total: 0 };
  const stats = [];
  if (counts.total > 0) {
    if (counts.attention) stats.push(el("span", { class: "stat is-attention" }, [el("b", { text: String(counts.attention) }), " attention"]));
    if (counts.active) stats.push(el("span", { class: "stat" }, [el("b", { text: String(counts.active) }), " in progress"]));
    if (counts.finished) stats.push(el("span", { class: "stat" }, [el("b", { text: String(counts.finished) }), " finished"]));
  }
  const statNodes = stats.flatMap((stat, index) => (index === 0 ? [stat] : [el("span", { class: "stat-sep", "aria-hidden": "true", text: "·" }), stat]));
  $("summary-line").replaceChildren(...(statNodes.length > 0 ? statNodes : [el("span", { class: "muted", text: summarySentence(counts) })]));
}

function renderTabs() {
  for (const tab of TABS) {
    const button = $(`tab-${tab}`);
    const panel = $(`panel-${tab}`);
    const active = state.tab === tab;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    panel.hidden = !active;
  }
  const count = (state.session?.artifacts || []).length;
  $("artifact-tab-count").textContent = count ? String(count) : "";
}

/* -------------------------------------------------------------- work panel */

function workRow(node, { attention = false } = {}) {
  const selected = node.id === state.selectedNodeId;
  const info = describeNode(node, { artifacts: graphState.current?.associations?.[node.id] || [] });
  const sub = node.sublabel || info.task || info.role || info.kindLabel;
  const meta = [info.updatedAt ? relativeTime(info.updatedAt) : "", node.scope || ""].filter(Boolean).join(" · ");
  return el(
    "button",
    {
      type: "button",
      class: `work-row kind-${node.kind}${attention ? " is-attention" : ""}${selected ? " is-selected" : ""}`,
      "data-action": "open-node",
      "data-node-id": node.id,
      "data-node-kind": node.kind,
      "aria-current": selected ? "true" : null,
    },
    [
      el("span", { class: "work-row-main" }, [
        el("span", { class: "work-row-title", text: node.displayName || node.label }),
        el("span", { class: "work-row-sub", text: sub }),
      ]),
      el("span", { class: "work-row-side" }, [
        kindChip(node.kind),
        badge(node.status),
        el("span", { class: "work-row-meta", text: meta }),
      ]),
    ],
  );
}

function workGroup(title, nodes, { attention = false } = {}) {
  if (nodes.length === 0) return null;
  return el("section", { class: "work-group", role: "listitem", "aria-label": title }, [
    el("div", { class: "group-head" }, [
      el("h3", { text: title }),
      el("span", { text: String(nodes.length) }),
    ]),
    el("div", { class: "work-rows" }, nodes.map((node) => workRow(node, { attention }))),
  ]);
}

function renderWorkEmpty(graph, counts) {
  const box = $("work-empty");
  if (state.viewMode !== "list" || counts.total > 0) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  const hasSession = Boolean(state.session);
  let message = "Select a session to see its work.";
  let action = null;
  if (hasSession) {
    const all = counts.total === 0 ? workCounts(projectGraph(state.session, { hideCompleted: false })) : counts;
    if (state.hideCompleted && all.total > 0) {
      message = `${all.total} finished ${all.total === 1 ? "item is" : "items are"} hidden.`;
      action = el("button", { type: "button", class: "button button-ghost", "data-action": "show-completed" }, ["Show completed"]);
    } else if (all.total > 0) {
      message = "Nothing needs your attention right now.";
      action = el("button", { type: "button", class: "button button-ghost", "data-action": "set-view", "data-view": "graph" }, ["Open graph view"]);
    } else {
      message = "No work items for this session yet. Start a handoff or spawn a worker to see it here.";
    }
  }
  box.replaceChildren(el("p", { text: message }), ...(action ? [action] : []));
}

function renderWorkPanel() {
  const graph = graphState.current;
  const listMode = state.viewMode === "list";
  $("view-list").setAttribute("aria-pressed", String(listMode));
  $("view-graph").setAttribute("aria-pressed", String(!listMode));
  $("hide-completed").checked = state.hideCompleted;

  const grouped = graph ? groupWork(graph) : { attention: [], active: [], finished: [] };
  const counts = graph ? workCounts(graph) : { attention: 0, active: 0, finished: 0, total: 0 };
  $("work-summary").textContent = graph
    ? `${counts.total} ${counts.total === 1 ? "item" : "items"}${state.hideCompleted ? " · completed hidden" : ""}`
    : "";

  const list = $("work-list");
  if (listMode) {
    const groups = [
      workGroup("Needs attention", grouped.attention, { attention: true }),
      workGroup("In progress", grouped.active),
      workGroup("Finished", grouped.finished),
    ].filter(Boolean);
    list.hidden = false;
    list.replaceChildren(...groups);
  } else {
    list.hidden = true;
    list.replaceChildren();
  }

  // One grouped list only: the "Needs attention" group already carries the 2px
  // `is-attention` rail, so a second tinted strip would duplicate every row.
  renderWorkEmpty(graph, counts);
  $("graph-view").hidden = listMode;
  renderLegend();
  renderGraphFrame();
  if (!listMode && state.tab === "work") void ensureGraph();
}

function renderLegend() {
  const legend = $("graph-legend");
  legend.hidden = !graphState.legendOpen;
  $("legend-toggle").setAttribute("aria-expanded", String(graphState.legendOpen));
  if (!graphState.legendOpen) {
    legend.replaceChildren();
    return;
  }
  legend.replaceChildren(
    el("div", { class: "legend" }, [
      el("div", { class: "legend-group" }, [
        el("h4", { class: "legend-heading", text: "Nodes" }),
        el("div", { class: "legend-items" }, LEGEND_NODES.map(({ kind, label }) =>
          el("span", { class: "legend-item" }, [
            el("span", { class: `shape-swatch kind-${kind}`, "aria-hidden": "true" }),
            el("span", { text: label }),
          ]),
        )),
      ]),
      el("div", { class: "legend-group" }, [
        el("h4", { class: "legend-heading", text: "Edges" }),
        el("div", { class: "legend-items" }, LEGEND_EDGES.map(({ kind, label }) =>
          el("span", { class: "legend-item" }, [
            el("span", { class: `line-swatch edge-${kind}`, "aria-hidden": "true" }),
            el("span", { text: label }),
          ]),
        )),
      ]),
      el("div", { class: "legend-group" }, [
        el("h4", { class: "legend-heading", text: "State" }),
        el("div", { class: "legend-items" }, LEGEND_STATUS.map(({ status, label }) =>
          el("span", { class: "legend-item" }, [
            el("span", { class: `dot status-${statusSlug(status)}`, "aria-hidden": "true" }),
            el("span", { text: label }),
          ]),
        )),
      ]),
    ]),
  );
}

function renderGraphFrame() {
  const graph = graphState.current;
  const empty = $("graph-empty");
  const errorBox = $("graph-error");
  const caption = $("graph-caption");
  if (graphState.error) {
    errorBox.hidden = false;
    errorBox.textContent = `Graph rendering failed: ${graphState.error}`;
    empty.hidden = true;
  } else {
    errorBox.hidden = true;
    empty.hidden = Boolean(graph && graph.nodes.length > 0 && graphState.svg);
    empty.textContent = graph && graph.nodes.length > 0
      ? "Rendering the workflow…"
      : "No workflow yet. The manager has not handed off any specs.";
  }
  const counts = graph?.counts;
  if (caption) {
    caption.textContent = graph
      ? `${graph.nodes.length} nodes · ${graph.edges.length} edges · ${counts.running} running`
      : "No graph data";
  }
  $("graph-status").textContent = graph
    ? `Graph updated: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${counts.running} workers running, ${counts.blocked} blocked, ${counts.escalations} escalations.${state.hideCompleted ? " Completed workers are hidden." : ""}`
    : "No graph data.";
}

/* ------------------------------------------------------------------- graph */

/** Cancel any in-flight viewBox tween (topology changed or graph unmounted). */
function cancelViewTween() {
  if (graphState.viewTween) {
    window.cancelAnimationFrame?.(graphState.viewTween);
    graphState.viewTween = null;
  }
}

function prefersReducedMotionNow() {
  try {
    return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  } catch {
    return false;
  }
}

/** Interpolate the SVG viewBox from the previous fitted view to the new one. */
function tweenViewBox(svg, from, to, duration) {
  if (!svg || !from || !to) return;
  const start = window.performance?.now?.() ?? Date.now();
  const write = (view) => {
    svg.setAttribute("viewBox", `${view.x.toFixed(3)} ${view.y.toFixed(3)} ${view.w.toFixed(3)} ${view.h.toFixed(3)}`);
  };
  write(from);
  const step = () => {
    const now = window.performance?.now?.() ?? Date.now();
    const progress = Math.min(1, (now - start) / duration);
    // Approximates cubic-bezier(.2,.7,.2,1): quick out, gentle settle.
    const eased = 1 - (1 - progress) ** 3;
    write({
      x: from.x + (to.x - from.x) * eased,
      y: from.y + (to.y - from.y) * eased,
      w: from.w + (to.w - from.w) * eased,
      h: from.h + (to.h - from.h) * eased,
    });
    if (progress < 1) {
      graphState.viewTween = window.requestAnimationFrame(step);
    } else {
      graphState.viewTween = null;
    }
  };
  graphState.viewTween = window.requestAnimationFrame(step);
}

function setClassTimed(element, className, duration) {
  if (!element) return;
  element.classList.add(className);
  window.setTimeout(() => element.classList.remove(className), duration);
}

/** Stagger the reveal of newly added nodes; instant when the tab is hidden. */
function revealNodes(svg, ids) {
  const instant = typeof document !== "undefined" && document.visibilityState === "hidden";
  ids.forEach((id, index) => {
    const element = svg.querySelector(`[data-node-id="${String(id).replace(/"/g, '\\"')}"]`);
    if (!element) return;
    if (instant) return;
    window.setTimeout(() => setClassTimed(element, "is-entering", MOTION.entryMs), staggerDelayMs(index, MOTION.staggerStepMs));
  });
}

/**
 * Draw edges in by animating `stroke-dashoffset` as presentation attributes.
 * `getTotalLength()` is guarded: jsdom and some engines return 0/undefined, in
 * which case the edge simply appears (no broken dashes left behind).
 */
function drawEdges(svg, graph, ids) {
  const byId = new Map((graph.edges || []).map((edge) => [edge.id, edge]));
  for (const id of ids) {
    const edge = byId.get(id);
    if (!edge) continue;
    const group = svg.querySelector(`[id="${edge.dotId}"]`);
    const path = group?.querySelector("path");
    if (!path || typeof path.getTotalLength !== "function") continue;
    let length = 0;
    try {
      length = Number(path.getTotalLength()) || 0;
    } catch {
      length = 0;
    }
    if (!length) continue;
    path.setAttribute("stroke-dasharray", String(length));
    path.setAttribute("stroke-dashoffset", String(length));
    // Force a style flush before transitioning, so the browser animates instead
    // of painting the final value straight away.
    void path.getBoundingClientRect?.();
    window.requestAnimationFrame(() => {
      path.setAttribute("stroke-dashoffset", "0");
    });
    window.setTimeout(() => {
      // Clean up so hover/focus and the DOT dash pattern are restored.
      path.removeAttribute("stroke-dasharray");
      path.removeAttribute("stroke-dashoffset");
    }, MOTION.edgeDrawMs + 40);
  }
}

function flashUpdatedNodes(svg, ids) {
  for (const id of ids) {
    const element = svg.querySelector(`[data-node-id="${String(id).replace(/"/g, '\\"')}"]`);
    setClassTimed(element, "is-updated", MOTION.statusFlashMs);
  }
}

async function ensureGraph() {
  const graph = graphState.current;
  const canvas = $("graph-canvas");
  if (!graph) {
    graphState.token += 1;
    cancelViewTween();
    canvas.replaceChildren();
    graphState.svg = null;
    graphState.signature = null;
    graphState.sessionId = null;
    graphState.previous = null;
    renderGraphFrame();
    return;
  }
  const signature = topologySignature(graph);
  const reducedMotion = prefersReducedMotionNow();
  const nextSnapshot = { nodes: graph.nodes, edges: graph.edges, signature };
  const previousView = graphState.svg && graphState.panzoom ? graphState.panzoom.getView() : null;
  if (graphState.signature === signature && graphState.svg) {
    // Status-only update: repaint in place, flash what changed, never relayout.
    const plan = planGraphMotion(graphState.previous, nextSnapshot, { reducedMotion });
    updateGraphSvg(graphState.svg, graph, { motion: !reducedMotion });
    selectGraphNode(graphState.svg, state.selectedNodeId);
    if (!reducedMotion) flashUpdatedNodes(graphState.svg, plan.updated);
    graphState.previous = nextSnapshot;
    renderGraphFrame();
    return;
  }
  const token = ++graphState.token;
  const sessionId = state.session?.session?.id || null;
  try {
    const dot = buildDot(graph);
    const rawSvg = await renderDot(dot);
    if (token !== graphState.token) return;
    const clean = sanitizeSvgMarkup(rawSvg, window);
    if (!clean) throw new Error("Graphviz produced invalid SVG");
    const parsed = new window.DOMParser().parseFromString(clean, "image/svg+xml");
    if (parsed.getElementsByTagName("parsererror").length > 0) throw new Error("Sanitized SVG could not be parsed");
    const svg = document.importNode(parsed.documentElement, true);
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    const plan = planGraphMotion(graphState.previous, nextSnapshot, { reducedMotion });
    graphState.panzoom?.destroy();
    cancelViewTween();
    canvas.replaceChildren(svg);
    decorateGraphSvg(svg, graph, document, { motion: !reducedMotion });
    selectGraphNode(svg, state.selectedNodeId);
    graphState.svg = svg;
    graphState.signature = signature;
    graphState.error = null;
    graphState.panzoom = createPanZoom(canvas, svg, {
      onChange: (_view, touched) => {
        graphState.viewportTouched = Boolean(touched);
      },
    });
    const fitted = graphState.sessionId !== sessionId || !graphState.viewportTouched;
    if (fitted) graphState.panzoom.fit();
    const targetView = graphState.panzoom.getView();
    if (fitted && previousView && plan.relayout && !reducedMotion) {
      tweenViewBox(svg, previousView, targetView, MOTION.relayoutMs);
    }
    if (!reducedMotion) {
      revealNodes(svg, plan.entering);
      drawEdges(svg, graph, plan.edgesToDraw);
    }
    graphState.sessionId = sessionId;
    graphState.previous = nextSnapshot;
    renderGraphFrame();
    announce(`Graph rendered with ${graph.nodes.length} nodes.`);
  } catch (error) {
    if (token !== graphState.token) return;
    graphState.error = safeText(error?.message || String(error), 300);
    graphState.svg = null;
    graphState.signature = null;
    graphState.previous = null;
    renderGraphFrame();
  }
}

function clearGraphState() {
  graphState.panzoom?.destroy();
  cancelViewTween();
  graphState.panzoom = null;
  graphState.current = null;
  graphState.signature = null;
  graphState.svg = null;
  graphState.sessionId = null;
  graphState.viewportTouched = false;
  graphState.error = null;
  graphState.legendOpen = false;
  graphState.previous = null;
  graphState.token += 1;
}

/* --------------------------------------------------------------- artifacts */

function renderArtifacts() {
  const all = state.session?.artifacts || [];
  const filtered = filterArtifacts(all, state.artifactQuery);
  $("artifact-count").textContent = `${filtered.length} of ${all.length}`;

  const empty = $("artifact-empty");
  empty.hidden = filtered.length > 0;
  empty.textContent = all.length > 0 ? "No artifacts match this search." : "This session has no artifacts yet.";

  const list = $("artifact-list");
  list.replaceChildren(
    ...filtered.map((artifact) => {
      const selected = artifact.id === state.selectedArtifactId;
      return el(
        "div",
        { role: "listitem" },
        [
          el(
            "button",
            {
              type: "button",
              class: `artifact-item${selected ? " is-active" : ""}`,
              "data-artifact-id": artifact.id,
              "data-version": artifact.version,
              "aria-current": selected ? "true" : null,
            },
            [
              el("span", { class: "artifact-item-title", text: artifact.title || artifact.id }),
              el("span", { class: "artifact-item-meta" }, [
                el("span", { class: `tag tag-${statusSlug(artifact.type)}`, text: artifact.type || "artifact" }),
                el("span", { text: `v${artifact.version}` }),
                artifact.scope ? el("span", { text: artifact.scope }) : null,
                el("span", { class: "muted", text: relativeTime(artifact.updatedAt) }),
              ]),
            ],
          ),
        ],
      );
    }),
  );
  renderArtifactDetail();
}

function artifactField(label, value) {
  return el("div", { class: "meta-field" }, [
    el("dt", { text: label }),
    el("dd", { text: value || "—" }),
  ]);
}

function artifactMetaLine(summary, artifact) {
  const version = artifact?.version ?? state.selectedArtifactVersion ?? summary?.version;
  return [
    version ? `v${version}` : "",
    artifact?.type || summary?.type || "artifact",
    artifact?.scope || summary?.scope || "session",
    relativeTime(artifact?.updatedAt || summary?.updatedAt),
  ].filter(Boolean).join(" · ");
}

function renderArtifactDetails(summary, artifact) {
  $("artifact-details-body").replaceChildren(
    el("dl", { class: "meta-grid single" }, [
      artifactField("Child", artifact?.childId || summary?.childId),
      artifactField("Tags", (artifact?.tags || summary?.tags || []).join(", ")),
      artifactField("Created", fmtDate(artifact?.createdAt || summary?.createdAt)),
      artifactField("Size", artifact?.content ? `${artifact.content.length.toLocaleString()} characters` : ""),
    ]),
  );
}

function renderArtifactDetail() {
  const summary = (state.session?.artifacts || []).find((artifact) => artifact.id === state.selectedArtifactId) || null;
  const artifact = state.artifact;
  const placeholder = $("artifact-placeholder");
  const view = $("artifact-view");
  if (!state.selectedArtifactId) {
    placeholder.hidden = false;
    view.hidden = true;
    $("artifact-content").replaceChildren();
    $("artifact-meta").textContent = "";
    $("artifact-details-body").replaceChildren();
    $("artifact-banner").hidden = true;
    $("artifact-banner").replaceChildren();
    lastArtifactRenderKey = null;
    return;
  }
  placeholder.hidden = true;
  view.hidden = false;

  $("artifact-title").textContent = artifact?.title || summary?.title || state.selectedArtifactId;
  $("artifact-subtitle").textContent = state.selectedArtifactId;
  $("artifact-meta").textContent = artifactMetaLine(summary, artifact);
  renderArtifactDetails(summary, artifact);

  const raw = state.artifactMode === "raw";
  const sourceButton = $("artifact-source");
  sourceButton.textContent = raw ? "View rendered" : "View source";
  sourceButton.setAttribute("aria-pressed", String(raw));
  sourceButton.dataset.mode = raw ? "raw" : "rendered";

  const banner = $("artifact-banner");
  if (state.artifactError) {
    banner.hidden = false;
    banner.replaceChildren(
      el("span", { text: `${state.artifactError.message}${state.artifactError.status ? ` (${state.artifactError.status})` : ""}` }),
      el("button", { type: "button", class: "button button-ghost", "data-action": "retry-artifact" }, ["Retry"]),
    );
  } else if (state.artifactStale) {
    banner.hidden = false;
    banner.replaceChildren(
      el("span", { text: `New version available (v${summary?.version ?? "?"}).` }),
      el("button", { type: "button", class: "button button-ghost", "data-action": "latest-artifact" }, ["Reload"]),
    );
  } else {
    banner.hidden = true;
    banner.replaceChildren();
  }

  const content = $("artifact-content");
  const key = [
    state.selectedArtifactId,
    artifact?.version ?? "none",
    artifact?.content?.length ?? 0,
    state.artifactMode,
    state.artifactStale ? "stale" : "fresh",
    state.artifactError?.message || "",
    summary?.version ?? "none",
  ].join("|");
  if (key === lastArtifactRenderKey) return;
  lastArtifactRenderKey = key;

  if (state.artifactError) {
    content.replaceChildren(el("p", { class: "empty-state small", text: "Artifact content is unavailable." }));
    return;
  }
  if (!artifact) {
    content.replaceChildren(el("p", { class: "empty-state small", text: "Loading artifact…" }));
    return;
  }
  if (state.artifactMode === "raw") {
    const code = el("code", { class: "raw-code", text: artifact.content });
    content.replaceChildren(el("pre", { class: "raw-block" }, [code]));
    return;
  }
  const html = renderMarkdownSafe(artifact.content, { marked, DOMPurify, dom: window });
  content.innerHTML = html || `<p class="empty-state small">(empty artifact)</p>`;
  highlightCode(content);
}

function highlightCode(root) {
  for (const code of root.querySelectorAll("pre code")) {
    const languageClass = [...code.classList].find((name) => name.startsWith("language-"));
    const language = languageClass ? languageClass.slice("language-".length).toLowerCase() : "";
    if (!language || !hljs.getLanguage(language)) continue;
    try {
      code.innerHTML = hljs.highlight(code.textContent || "", { language, ignoreIllegals: true }).value;
      code.classList.add("hljs");
    } catch {
      // Keep the plain, already-sanitized text when highlighting fails.
    }
  }
}

/* ------------------------------------------------------------------ drawer */

function selectedNodeDetail() {
  const graph = graphState.current;
  if (!graph || !state.selectedNodeId) return { node: null, info: null };
  const node = graph.nodes.find((candidate) => candidate.id === state.selectedNodeId) || null;
  if (!node) return { node: null, info: null };
  return { node, info: describeNode(node, { artifacts: graph.associations?.[node.id] || [] }) };
}

function nodeField(label, value) {
  return el("div", { class: "field" }, [el("dt", { text: label }), el("dd", { text: value })]);
}

function detailSection(heading, children, note = "") {
  return el("section", { class: "detail-section" }, [
    el("h4", { class: "detail-heading", text: heading }),
    note ? el("p", { class: "muted small", text: note }) : null,
    ...(Array.isArray(children) ? children : [children]),
  ].filter(Boolean));
}

function textSection(heading, text, emptyText) {
  return detailSection(
    heading,
    text ? el("p", { class: "detail-text", text }) : el("p", { class: "muted small", text: emptyText }),
  );
}

function copyButton(label, field) {
  return el("button", { type: "button", class: "link-button", "data-action": "copy", "data-copy": field }, [label]);
}

function fileListSection(title, files) {
  if (!files || files.length === 0) return null;
  const shown = files.slice(0, MAX_FILES_SHOWN);
  return detailSection(title, [
    el("ul", { class: "file-list" }, shown.map((file) => el("li", {}, [el("code", { text: file })]))),
    files.length > shown.length ? el("p", { class: "muted small", text: `+${files.length - shown.length} more` }) : null,
  ].filter(Boolean));
}

function artifactLinksSection(info) {
  if (!info.artifacts.length) return null;
  return detailSection("Artifacts", el("div", { class: "drawer-actions" }, info.artifacts.map((artifact) =>
    el(
      "button",
      {
        type: "button",
        class: "link-button",
        "data-action": "open-artifact",
        "data-artifact-id": artifact.id,
        "data-version": artifact.version,
      },
      [`${artifact.title} · v${artifact.version}`],
    ),
  )));
}

function workerSection(info) {
  if (info.workers.length === 0) {
    return detailSection("Workers", el("p", { class: "muted small", text: "No workers are attached to this handoff yet." }));
  }
  return detailSection("Workers", el("ul", { class: "detail-workers" }, info.workers.map((worker) =>
    el("li", {}, [
      el(
        "button",
        {
          type: "button",
          class: "detail-worker",
          "data-action": "open-node",
          "data-node-id": worker.id,
        },
        [
          el("span", { text: worker.label }),
          badge(worker.status),
          worker.sublabel ? el("span", { class: "muted small", text: worker.sublabel }) : null,
        ].filter(Boolean),
      ),
    ]),
  )));
}

function relatedSection(info, node) {
  const graph = graphState.current;
  if (!graph) return null;
  const links = [];
  if (info.handoffId) links.push(["Open handoff", `handoff:${info.handoffId}`]);
  if (info.reviewRunId) links.push(["Open spec review", `spec-review:${info.reviewRunId}`]);
  if (node?.raw?.childId) links.push(["Open worker", `child:${node.raw.childId}`]);
  const present = links.filter(([, nodeId]) => graph.nodes.some((candidate) => candidate.id === nodeId));
  if (present.length === 0) return null;
  return detailSection("Related", el("div", { class: "drawer-actions" }, present.map(([label, nodeId]) =>
    el("button", { type: "button", class: "link-button", "data-action": "open-node", "data-node-id": nodeId }, [label]),
  )));
}

function advancedDetails(info) {
  const fields = [
    nodeField("Node id", info.id),
    info.handoffId ? nodeField("Handoff id", info.handoffId) : null,
    info.reviewRunId ? nodeField("Spec review id", info.reviewRunId) : null,
    info.reviewLens ? nodeField("Review lens", info.reviewLens) : null,
    info.pendingPing ? nodeField("Pending", "Awaiting an answer") : null,
    info.startedAt ? nodeField("Started", fmtDate(info.startedAt)) : null,
    info.updatedAt ? nodeField("Updated", fmtDate(info.updatedAt)) : null,
    info.budgetMs ? nodeField("Budget", fmtDuration(info.budgetMs)) : null,
    info.lastTokens ? nodeField("Last tokens", String(info.lastTokens)) : null,
    info.lastContextWindow ? nodeField("Context window", String(info.lastContextWindow)) : null,
    info.closeReason ? nodeField("Close reason", info.closeReason) : null,
    info.supersededIds.length ? nodeField("Superseded", info.supersededIds.join(", ")) : null,
  ].filter(Boolean);
  return el("details", { class: "advanced" }, [
    el("summary", { text: "Technical details" }),
    el("dl", { class: "field-list" }, fields),
  ]);
}

function handoffDrawerBody(info) {
  return [
    detailSection("Handoff", el("dl", { class: "field-list" }, [
      nodeField("Status", info.statusLabel),
      info.scope ? nodeField("Scope", info.scope) : null,
      info.handoffId ? nodeField("Handoff id", info.handoffId) : null,
    ].filter(Boolean))),
    textSection("Goal", info.goal, "No goal recorded on this handoff."),
    el("div", { class: "drawer-actions" }, [
      copyButton("Copy goal", "goal"),
      copyButton("Copy acceptance criteria", "criteria"),
    ]),
    detailSection(
      "Acceptance criteria (from the handoff)",
      info.acceptanceCriteria.length
        ? el("ol", { class: "detail-criteria" }, info.acceptanceCriteria.map((criterion) => el("li", { text: criterion })))
        : el("p", { class: "muted small", text: "The handoff lists no acceptance criteria." }),
      "Copied from the handoff spec so it can be checked off work item by work item.",
    ),
    workerSection(info),
    artifactLinksSection(info),
    relatedSection(info, null),
    advancedDetails(info),
  ].filter(Boolean);
}

function childDrawerBody(info, node) {
  return [
    detailSection("Worker", el("dl", { class: "field-list" }, [
      nodeField("Status", info.statusLabel),
      info.scope ? nodeField("Scope", info.scope) : null,
      info.task ? nodeField("Task", info.task) : null,
    ].filter(Boolean))),
    fileListSection("Lane files", info.laneFiles),
    fileListSection("Last milestone files", info.lastMilestoneFiles),
    artifactLinksSection(info),
    relatedSection(info, node),
    advancedDetails(info),
  ].filter(Boolean);
}

function reviewDrawerBody(info, node) {
  return [
    detailSection("Review", el("dl", { class: "field-list" }, [
      nodeField("Verdict", info.statusLabel),
      info.scope ? nodeField("Scope", info.scope) : null,
      info.reviewLens ? nodeField("Lens", info.reviewLens) : null,
    ].filter(Boolean))),
    textSection("Summary", info.summary, "This review has no summary."),
    relatedSection(info, node),
    advancedDetails(info),
  ].filter(Boolean);
}

function escalationDrawerBody(info, node) {
  return [
    detailSection("Escalation", el("dl", { class: "field-list" }, [
      nodeField("Status", info.statusLabel),
      info.scope ? nodeField("Scope", info.scope) : null,
      node.raw?.childId ? nodeField("Raised by", String(node.raw.childId)) : null,
    ].filter(Boolean))),
    textSection("Question", info.question, "No question text was recorded."),
    el("div", { class: "drawer-actions" }, [copyButton("Copy question", "question")]),
    relatedSection(info, node),
    advancedDetails(info),
  ].filter(Boolean);
}

function specReviewDrawerBody(info, node) {
  const reviewers = Array.isArray(node.raw?.reviewerIds) ? node.raw.reviewerIds.length : 0;
  return [
    detailSection("Spec review", el("dl", { class: "field-list" }, [
      nodeField("Status", info.statusLabel),
      reviewers ? nodeField("Reviewers", `${reviewers} assigned`) : null,
      info.scope ? nodeField("Scope", info.scope) : null,
    ].filter(Boolean))),
    relatedSection(info, node),
    advancedDetails(info),
  ].filter(Boolean);
}

function genericDrawerBody(info, node) {
  return [
    detailSection("Details", el("dl", { class: "field-list" }, [
      nodeField("Status", info.statusLabel),
      nodeField("Kind", info.kindLabel),
      info.scope ? nodeField("Scope", info.scope) : null,
      info.task ? nodeField("Task", info.task) : null,
      info.question ? nodeField("Question", info.question) : null,
      info.summary ? nodeField("Summary", info.summary) : null,
    ].filter(Boolean))),
    relatedSection(info, node),
    advancedDetails(info),
  ].filter(Boolean);
}

function drawerBodyFor(node, info) {
  switch (info.kind) {
    case "handoff":
      return handoffDrawerBody(info);
    case "child":
      return childDrawerBody(info, node);
    case "review":
      return reviewDrawerBody(info, node);
    case "escalation":
      return escalationDrawerBody(info, node);
    case "spec-review":
      return specReviewDrawerBody(info, node);
    default:
      return genericDrawerBody(info, node);
  }
}

function artifactDrawerBody(summary, artifact) {
  const fields = [
    artifactField("Version", String(artifact?.version ?? state.selectedArtifactVersion ?? "")),
    artifactField("Type", artifact?.type || summary?.type),
    artifactField("Scope", artifact?.scope || summary?.scope || "session"),
    artifactField("Child", artifact?.childId || summary?.childId),
    artifactField("Tags", (artifact?.tags || summary?.tags || []).join(", ")),
    artifactField("Updated", fmtDate(artifact?.updatedAt || summary?.updatedAt)),
  ];
  return [
    detailSection("Artifact", el("dl", { class: "meta-grid single" }, fields)),
    el("div", { class: "drawer-actions" }, [
      el("button", { type: "button", class: "link-button", "data-action": "show-artifact-tab" }, ["Open in Artifacts tab"]),
      el("button", { type: "button", class: "link-button", "data-action": "copy-artifact-id" }, ["Copy id"]),
    ]),
    state.artifactError
      ? textSection("Error", state.artifactError.message, "")
      : state.artifactStale
        ? el("div", { class: "banner banner-warn small", text: "New version available." })
        : null,
  ].filter(Boolean);
}

function rememberTrigger(element) {
  if (element && typeof element.focus === "function") drawerState.returnFocus = element;
}

function renderDrawer() {
  const drawer = $("drawer");
  const backdrop = $("drawer-backdrop");
  const open = Boolean(state.detailOpen);

  drawer.hidden = !open;
  backdrop.hidden = !open;
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");
  drawer.setAttribute("aria-labelledby", "drawer-title");
  drawer.removeAttribute("aria-label");
  backdrop.removeAttribute("tabindex");

  if (open && !drawerState.open) {
    drawerState.open = true;
    const title = $("drawer-title");
    title.setAttribute("tabindex", "-1");
    title.focus({ preventScroll: true });
  } else if (!open && drawerState.open) {
    drawerState.open = false;
    const target = drawerState.returnFocus;
    drawerState.returnFocus = null;
    if (target && target.isConnected !== false) {
      try {
        target.focus({ preventScroll: true });
      } catch {
        // The trigger was removed with a re-render; focus stays where it is.
      }
    }
  }

  const kind = $("drawer-kind");
  const title = $("drawer-title");
  const meta = $("drawer-meta");
  const body = $("drawer-body");
  if (!open) {
    kind.replaceChildren();
    title.textContent = "";
    meta.textContent = "";
    body.replaceChildren();
    return;
  }

  const { node, info } = selectedNodeDetail();
  if (info) {
    kind.replaceChildren(icon(info.kindGlyph, "icon icon-kind"), el("span", { text: info.kindLabel }));
    title.textContent = info.displayName || info.label;
    meta.textContent = [
      info.role && info.role !== info.kindLabel ? info.role : "",
      info.statusLabel,
      info.scope,
      info.updatedAt ? `updated ${relativeTime(info.updatedAt)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    body.replaceChildren(...drawerBodyFor(node, info));
    return;
  }

  const summary = state.selectedArtifactId
    ? (state.session?.artifacts || []).find((artifact) => artifact.id === state.selectedArtifactId) || null
    : null;
  if (summary || state.selectedArtifactId) {
    const artifact = state.artifact;
    kind.replaceChildren(icon("snippet", "icon icon-kind"), el("span", { text: "Artifact" }));
    title.textContent = artifact?.title || summary?.title || state.selectedArtifactId;
    meta.textContent = artifactMetaLine(summary, artifact);
    body.replaceChildren(...artifactDrawerBody(summary, artifact));
    return;
  }

  kind.replaceChildren(el("span", { text: "Detail" }));
  title.textContent = "Nothing selected";
  meta.textContent = "";
  body.replaceChildren(el("p", { class: "empty-state small", text: "Pick a work unit or a graph node to see its spec, lane and artifacts." }));
}

function currentDrawerCopyText(field) {
  const { info } = selectedNodeDetail();
  if (!info) return "";
  if (field === "goal") return info.goal;
  if (field === "criteria") {
    return info.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n");
  }
  if (field === "question") return info.question;
  return "";
}

/* ----------------------------------------------------------------- actions */

async function loadSession(id = state.selectedSessionId, { silent = false } = {}) {
  if (!id) return;
  const token = S.sessionToken(state);
  try {
    const { session } = await api.session(id);
    const before = state;
    const next = S.applySessionView(before, session, token);
    if (next === before) {
      await applyPendingUrl();
      return;
    }
    state = next;
    render();
    await applyPendingUrl();
    maybeRefreshStaleArtifact();
  } catch (error) {
    if (!S.isSessionTokenCurrent(state, token)) return;
    if (error?.status === 404) {
      void refreshSessions();
      return;
    }
    if (!silent) setState(S.setError(state, error.message));
  }
}

async function refreshSessions() {
  const previousId = state.selectedSessionId;
  try {
    const { sessions } = await api.sessions();
    const next = S.applySessions(state, sessions);
    if (next !== state) {
      if (next.selectedSessionId !== previousId) clearGraphState();
      state = next;
      render();
    }
  } catch (error) {
    setState(S.setError(S.setConnection(state, "offline"), error.message));
    return;
  }
  if (state.selectedSessionId) await loadSession(state.selectedSessionId, { silent: true });
}

async function refreshAll() {
  await refreshSessions();
}

function chooseSession(id) {
  if (!id || id === state.selectedSessionId) return;
  const wasMobile = $("app").classList.contains("sidebar-open");
  state = S.selectSession(state, id);
  lastArtifactRenderKey = null;
  clearGraphState();
  render();
  if (wasMobile) setSidebarOpen(false);
  announce(`Loading session ${id}.`);
  void loadSession(id);
}

function openNode(nodeId, trigger) {
  if (!nodeId) return;
  const wasOpen = state.detailOpen;
  if (!wasOpen) rememberTrigger(trigger || document.activeElement);
  state = S.openNodeDetail(state, nodeId);
  render();
  if (wasOpen) {
    const title = $("drawer-title");
    title.setAttribute("tabindex", "-1");
    title.focus({ preventScroll: true });
  }
  const label = graphState.current?.nodes.find((node) => node.id === nodeId)?.label || nodeId;
  announce(`Details for ${label}.`);
}

function closeDrawer() {
  if (!state.detailOpen) return;
  // Closing a node detail must not silently drop an artifact the user is reading
  // in the Artifacts tab, so the artifact selection survives.
  state = state.selectedArtifactId
    ? { ...state, detailOpen: false, selectedNodeId: null }
    : S.closeDetail(state);
  render();
  announce("Detail closed.");
}

function revealArtifact(id, version, { openTab = false } = {}) {
  if (!id) return;
  const summary = (state.session?.artifacts || []).find((artifact) => artifact.id === id);
  const targetVersion = version == null || Number.isNaN(Number(version)) ? summary?.version : Number(version);
  if (targetVersion == null) {
    announce("That artifact is not in this session.");
    return;
  }
  const alreadyLoaded = Boolean(
    state.artifact
    && state.artifact.id === id
    && Number(state.artifact.version) === Number(targetVersion)
    && !state.artifactStale,
  );
  const keepNodeId = state.selectedNodeId;
  const keepDrawer = state.detailOpen;
  state = S.selectArtifact(state, id, targetVersion);
  // The artifact panel is the artifact's detail surface; the drawer is reserved
  // for work items. Following a link out of the drawer closes it (and drops the
  // node), but a refresh triggered by staleness must not yank an open detail.
  state = {
    ...state,
    detailOpen: openTab ? false : keepDrawer && Boolean(keepNodeId),
    selectedNodeId: openTab ? null : keepNodeId,
  };
  if (openTab) state = S.setTab(state, "artifacts");
  lastArtifactRenderKey = null;
  render();
  if (!alreadyLoaded) void loadArtifact();
}

async function loadArtifact() {
  const token = S.artifactToken(state);
  if (!token.id || token.sessionId == null || token.version == null) return;
  try {
    const { artifact } = await api.artifact(token.sessionId, token.id, token.version);
    const next = S.applyArtifact(state, artifact, token);
    if (next === state) return;
    setState(next);
  } catch (error) {
    const next = S.applyArtifactError(state, error, token);
    if (next !== state) setState(next);
    if (error?.status === 404 || error?.status === 409) {
      void loadSession(state.selectedSessionId, { silent: true });
    }
  }
}

function maybeRefreshStaleArtifact() {
  if (!state.artifactStale || state.artifactError || !state.selectedArtifactId) return;
  const summary = S.latestSummary(state, state.selectedArtifactId);
  if (!summary || Number(summary.version) === Number(state.selectedArtifactVersion)) return;
  revealArtifact(summary.id, summary.version);
}

function setViewMode(mode) {
  if (mode !== "list" && mode !== "graph") return;
  state = S.setViewMode(state, mode);
  render();
  announce(mode === "graph" ? "Graph view." : "List view.");
}

async function copyText(text, label) {
  if (!text) {
    announce(`Nothing to copy for the ${label}.`);
    return;
  }
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else fallbackCopy(text);
    announce(`Copied the ${label}.`);
  } catch {
    try {
      fallbackCopy(text);
      announce(`Copied the ${label}.`);
    } catch {
      announce(`Could not copy the ${label}.`);
    }
  }
}

function fallbackCopy(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.className = "sr-only";
  document.body.append(area);
  area.select();
  const copied = document.execCommand?.("copy");
  area.remove();
  if (!copied) throw new Error("copy failed");
}

/* -------------------------------------------------------------- URL state */

function parseArtifactParam(value) {
  if (!value) return null;
  const at = value.lastIndexOf("@");
  const id = at > 0 ? value.slice(0, at) : value;
  const versionText = at > 0 ? value.slice(at + 1) : "";
  const version = versionText && /^\d+$/.test(versionText) ? Number(versionText) : null;
  return id ? { id, version } : null;
}

function parseUrlSelection() {
  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return { session: null, node: null, artifact: null };
  }
  return {
    session: params.get("session") || null,
    node: params.get("node") || null,
    artifact: parseArtifactParam(params.get("artifact")),
  };
}

/** Apply one URL selection to the current state; unknown values are dropped. */
function applyUrlSelection(current, target) {
  const graph = current.session ? projectGraph(current.session, { hideCompleted: current.hideCompleted }) : null;
  const nodeId = target.node && graph?.nodes.some((node) => node.id === target.node) ? target.node : null;
  const summary = target.artifact
    ? (current.session?.artifacts || []).find((artifact) => artifact.id === target.artifact.id)
    : null;
  const artifact = summary ? { id: summary.id, version: target.artifact.version ?? summary.version } : null;

  const artifactChanged = artifact
    ? current.selectedArtifactId !== artifact.id || Number(current.selectedArtifactVersion) !== Number(artifact.version)
    : Boolean(current.selectedArtifactId);

  let next = {
    ...current,
    selectedNodeId: nodeId,
    detailOpen: Boolean(nodeId),
    selectedArtifactId: artifact?.id ?? null,
    selectedArtifactVersion: artifact ? artifact.version : null,
  };
  if (artifactChanged) {
    next = { ...next, artifact: null, artifactEpoch: current.artifactEpoch + 1, artifactStale: false, artifactError: null };
  }
  if (artifact && !nodeId) next = S.setTab(next, "artifacts");
  return { next, artifact };
}

async function applyPendingUrl() {
  if (!pendingUrl || !state.session) return;
  const target = pendingUrl;
  pendingUrl = null;
  const { next, artifact } = applyUrlSelection(state, target);
  const changed = next !== state;
  state = next;
  if (changed) {
    lastArtifactRenderKey = null;
    render();
  }
  if (artifact) await loadArtifact();
  syncUrl();
}

function syncUrl() {
  if (!urlState.ready || urlState.applying) return;
  const params = new URLSearchParams();
  if (state.selectedSessionId) params.set("session", state.selectedSessionId);
  if (state.selectedNodeId) params.set("node", state.selectedNodeId);
  if (state.selectedArtifactId) {
    params.set(
      "artifact",
      state.selectedArtifactVersion == null
        ? state.selectedArtifactId
        : `${state.selectedArtifactId}@${state.selectedArtifactVersion}`,
    );
  }
  const search = params.toString();
  const next = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  try {
    window.history.replaceState(window.history.state, "", next);
  } catch {
    // History is unavailable (sandboxed or file: document); selection still works.
  }
}

async function handlePopState() {
  const target = parseUrlSelection();
  urlState.applying = true;
  try {
    if (!urlState.ready) return;
    if (target.session && target.session !== state.selectedSessionId) {
      if (!state.sessions.some((session) => session.id === target.session)) return;
      pendingUrl = target;
      chooseSession(target.session);
      return;
    }
    if (state.session) {
      pendingUrl = target;
      await applyPendingUrl();
    }
  } finally {
    urlState.applying = false;
    if (!pendingUrl) syncUrl();
  }
}

/* ------------------------------------------------------------------ events */

function connectEvents() {
  let source;
  try {
    source = new EventSource("/api/events");
  } catch {
    setState(S.setConnection(state, "offline"));
    return;
  }
  const coalescer = createChangeCoalescer(() => void refreshAll(), { delay: 250 });
  source.addEventListener("open", () => setState(S.setConnection(state, "live")));
  source.addEventListener("error", () => {
    setState(S.setConnection(state, "offline"));
  });
  source.addEventListener("message", (event) => {
    if (parseChangeEvent(event.data)) coalescer.trigger();
  });
  window.addEventListener("beforeunload", () => {
    coalescer.cancel();
    source.close();
  });
}

function setSidebarOpen(open) {
  $("app").classList.toggle("sidebar-open", open);
  $("nav-toggle").setAttribute("aria-expanded", String(open));
}

/* -------------------------------------------------------------------- boot */

function bindControls() {
  $("nav-toggle").addEventListener("click", () => setSidebarOpen(!$("app").classList.contains("sidebar-open")));
  $("sidebar-close").addEventListener("click", () => setSidebarOpen(false));

  $("session-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-session-id]");
    if (button) chooseSession(button.dataset.sessionId);
  });

  const tablist = document.querySelector(".tabs");
  tablist.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (button) setState(S.setTab(state, button.dataset.tab));
  });
  tablist.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const index = TABS.indexOf(state.tab);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? TABS.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
    setState(S.setTab(state, TABS[nextIndex]));
    $(`tab-${TABS[nextIndex]}`).focus();
  });

  $("view-list").addEventListener("click", () => setViewMode("list"));
  $("view-graph").addEventListener("click", () => setViewMode("graph"));

  $("hide-completed").addEventListener("change", (event) => {
    state = { ...state, hideCompleted: Boolean(event.target.checked) };
    graphState.signature = null;
    render();
  });

  $("graph-fit").addEventListener("click", () => graphState.panzoom?.fit());
  $("graph-zoom-in").addEventListener("click", () => graphState.panzoom?.zoomBy(1 / 1.2));
  $("graph-zoom-out").addEventListener("click", () => graphState.panzoom?.zoomBy(1.2));
  $("legend-toggle").addEventListener("click", () => {
    graphState.legendOpen = !graphState.legendOpen;
    renderLegend();
  });

  $("graph-canvas").addEventListener("click", (event) => {
    const nodeId = graphNodeFromEvent(event.target);
    if (!nodeId) return;
    openNode(nodeId, event.target.closest?.("g.graph-node") || null);
  });
  $("graph-canvas").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const nodeId = graphNodeFromEvent(event.target);
    if (!nodeId) return;
    event.preventDefault();
    openNode(nodeId, event.target.closest?.("g.graph-node") || null);
  });

  $("panel-work").addEventListener("click", (event) => {
    const nodeButton = event.target.closest?.('[data-action="open-node"]');
    if (nodeButton) {
      openNode(nodeButton.dataset.nodeId, nodeButton);
      return;
    }
    const actionButton = event.target.closest?.("[data-action]");
    if (!actionButton) return;
    const action = actionButton.dataset.action;
    if (action === "show-completed") {
      state = { ...state, hideCompleted: false };
      graphState.signature = null;
      render();
    } else if (action === "set-view") {
      setViewMode(actionButton.dataset.view);
    }
  });

  $("artifact-query").addEventListener("input", (event) => {
    state = { ...state, artifactQuery: event.target.value };
    renderArtifacts();
  });
  $("artifact-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-artifact-id]");
    if (button) revealArtifact(button.dataset.artifactId, button.dataset.version);
  });
  $("artifact-source").addEventListener("click", () => {
    state = { ...state, artifactMode: state.artifactMode === "raw" ? "rendered" : "raw" };
    lastArtifactRenderKey = null;
    renderArtifacts();
  });
  $("artifact-detail").addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "retry-artifact") revealArtifact(state.selectedArtifactId, state.selectedArtifactVersion);
    else if (action === "latest-artifact") {
      const summary = S.latestSummary(state, state.selectedArtifactId);
      if (summary) revealArtifact(summary.id, summary.version);
    }
  });

  $("drawer").addEventListener("click", (event) => {
    if (event.target.closest("#drawer-close")) {
      closeDrawer();
      return;
    }
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "open-node") openNode(button.dataset.nodeId, button);
    else if (action === "open-artifact") revealArtifact(button.dataset.artifactId, button.dataset.version, { openTab: true });
    else if (action === "copy") {
      const field = button.dataset.copy;
      void copyText(currentDrawerCopyText(field), COPY_LABELS[field] || "value");
    } else if (action === "copy-artifact-id") {
      void copyText(state.selectedArtifactId || "", "artifact id");
    } else if (action === "show-artifact-tab") {
      state = S.setTab({ ...state, detailOpen: false, selectedNodeId: null }, "artifacts");
      render();
    }
  });
  $("drawer-backdrop").addEventListener("click", () => closeDrawer());

  $("error-retry").addEventListener("click", () => {
    setState(S.setError(state, null));
    void refreshAll();
  });

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (state.detailOpen) {
      closeDrawer();
      return;
    }
    if (graphState.legendOpen) {
      graphState.legendOpen = false;
      renderLegend();
      $("legend-toggle").focus();
      return;
    }
    if ($("app").classList.contains("sidebar-open")) setSidebarOpen(false);
  });

  window.addEventListener("popstate", () => {
    void handlePopState();
  });
}

async function boot() {
  bindControls();
  render();
  const target = parseUrlSelection();
  try {
    const { sessions } = await api.sessions();
    let next = S.applySessions(state, sessions);
    if (target.session && sessions.some((session) => session.id === target.session)) {
      next = S.selectSession(next, target.session);
    }
    state = S.setConnection(next, "live");
    render();
    if (state.selectedSessionId) {
      pendingUrl = target;
      await loadSession(state.selectedSessionId);
    }
    pendingUrl = null;
    urlState.ready = true;
    syncUrl();
  } catch (error) {
    state = S.setError(S.setConnection(state, "offline"), `Cannot reach the dashboard API: ${error.message}`);
    urlState.ready = true;
    render();
  }
  connectEvents();
}

void boot();
