"use client";

import React, { useState } from "react";
import type { GraphEdge, GraphNode, ListStatus, WebView } from "@/lib/web-ui-views";
import { MarkdownBody } from "../MarkdownBody";
export { useWebUiState as usePluginData } from "@/hooks/useWebUiState";
export type { PluginSessionState, PluginDataState } from "@/hooks/useWebUiState";

export interface SessionStatusDotProps {
  running?: boolean; awaitingInput?: boolean; sessionId?: string; showLabel?: boolean; className?: string;
}
export function SessionStatusDot({ running, awaitingInput, sessionId, showLabel = false, className = "" }: SessionStatusDotProps) {
  const label = running ? awaitingInput ? "awaiting input" : "running" : "idle";
  const title = sessionId ? `${sessionId} (${label})` : label;
  return <span className={`plugin-status-indicator ${className}`} title={title} aria-label={title}>
    <span className={`plugin-status-dot ${running ? "plugin-status-running" : "plugin-status-idle"}`} data-testid="plugin-status-dot" />
    {showLabel && <span className="plugin-status-label">{label}</span>}
  </span>;
}

/**
 * Line-art icons in pi-web's stroke style. The status vocabulary is the view
 * contract's closed set, so a plugin never ships an icon or glyph of its own.
 */
const STATUS_ICONS: Record<ListStatus, React.ReactNode> = {
  pending: <circle cx="12" cy="12" r="9" />,
  active: <><path d="M12 3a9 9 0 1 0 9 9" /><path d="M12 3a9 9 0 0 1 9 9" /><path d="M12 12l4-4" /></>,
  done: <><circle cx="12" cy="12" r="9" /><path d="m8.5 12.2 2.3 2.3 4.7-4.9" /></>,
  blocked: <><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></>,
  failed: <><circle cx="12" cy="12" r="9" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></>,
  neutral: <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />,
};
export function StatusIcon({ status, size = 14 }: { status: ListStatus; size?: number }) {
  return <svg className={`plugin-item-icon plugin-item-icon-${status}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {STATUS_ICONS[status]}
  </svg>;
}

/**
 * A row's markdown body. Opened on demand and rendered through the host's own
 * sanitising markdown pipeline — plugin data stays data, never HTML.
 */
function DetailBody({ detail }: { detail: string }) {
  return <div className="plugin-item-detail" data-testid="plugin-item-detail">
    <MarkdownBody className="markdown-body plugin-item-detail-body">{detail}</MarkdownBody>
  </div>;
}

function ExpandChevron({ open }: { open: boolean }) {
  return <span className="plugin-list-item-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>;
}

function ListItemRow({ item }: { item: string | { text: string; status?: ListStatus; detail?: string } }) {
  const [open, setOpen] = useState(false);
  if (typeof item === "string") return <li className="plugin-list-item">{item}</li>;
  const icon = item.status ? <StatusIcon status={item.status} /> : null;
  if (item.detail === undefined) {
    return <li className="plugin-list-item plugin-list-item-rich">{icon}<span className="plugin-list-item-text">{item.text}</span></li>;
  }
  return <li className={`plugin-list-item plugin-list-item-rich${open ? " is-open" : ""}`}>
    <button type="button" className="plugin-list-item-toggle" aria-expanded={open} onClick={() => setOpen(v => !v)} title={open ? "Collapse" : "Expand"}>
      {icon}<span className="plugin-list-item-text">{item.text}</span><ExpandChevron open={open} />
    </button>
    {open ? <DetailBody detail={item.detail} /> : null}
  </li>;
}

interface GraphTreeRow { node: GraphNode; edgeLabel?: string; children: GraphTreeRow[] }

/** Depth-first rows from the edge list; roots are parents, then edge-free nodes, then orphans. */
function buildGraphRows(view: Extract<WebView, { type: "graph" }>): GraphTreeRow[] {
  const byId = new Map(view.nodes.map(node => [node.id, node]));
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of view.edges) {
    if (edge.from === edge.to) continue;
    const list = outgoing.get(edge.from);
    if (list) list.push(edge); else outgoing.set(edge.from, [edge]);
  }
  const hasIncoming = new Set(view.edges.map(edge => edge.to));
  const seen = new Set<string>();
  const build = (id: string, edgeLabel?: string): GraphTreeRow | null => {
    if (seen.has(id)) return null;
    const node = byId.get(id);
    if (!node) return null;
    seen.add(id);
    const children = (outgoing.get(id) ?? [])
      .map(edge => build(edge.to, edge.label))
      .filter((row): row is GraphTreeRow => row !== null);
    return { node, edgeLabel, children };
  };
  const roots = [
    ...view.nodes.filter(node => node.kind === "parent"),
    ...view.nodes.filter(node => node.kind !== "parent" && !hasIncoming.has(node.id)),
  ];
  const rows = roots.map(root => build(root.id)).filter((row): row is GraphTreeRow => row !== null);
  for (const node of view.nodes) {
    if (seen.has(node.id)) continue;
    const row = build(node.id);
    if (row) rows.push(row);
  }
  return rows;
}

function GraphRows({ rows }: { rows: GraphTreeRow[] }) {
  return <ul className="plugin-graph-children">
    {rows.map(row => <GraphNodeRow key={row.node.id} row={row} />)}
  </ul>;
}

function GraphNodeRow({ row }: { row: GraphTreeRow }) {
  const [open, setOpen] = useState(false);
  const { node } = row;
  const detail = node.detail;
  const kind = node.kind && node.kind !== "child" ? <span className={`plugin-graph-kind plugin-graph-kind-${node.kind}`}>{node.kind}</span> : null;
  const relation = row.edgeLabel ? <span className="plugin-graph-relation-label">↳ {row.edgeLabel}</span> : null;
  const body = <>{node.status && <StatusIcon status={node.status} />}<span className="plugin-graph-node-label">{node.label}</span>{kind}{relation}</>;
  return <li className={`plugin-graph-node kind-${node.kind ?? "child"}`} data-node-id={node.id}>
    {detail !== undefined
      ? <button type="button" className="plugin-graph-node-toggle" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        {body}<ExpandChevron open={open} />
      </button>
      : <div className="plugin-graph-node-row">{body}</div>}
    {detail !== undefined && open ? <DetailBody detail={detail} /> : null}
    {row.children.length ? <GraphRows rows={row.children} /> : null}
  </li>;
}

export function PluginViewRenderer({ view }: { view: WebView | null | undefined }) {
  if (!view) return <div className="plugin-empty-state" data-testid="plugin-empty-state"><p>No view published yet</p></div>;
  switch (view.type) {
    case "kv": return <div className="plugin-view plugin-view-kv" data-testid="plugin-view-kv">
      {view.title && <h3 className="plugin-view-title">{view.title}</h3>}
      <table className="plugin-kv-table"><tbody>{view.rows.map((row, index) => <tr key={index} className="plugin-kv-row"><td className="plugin-kv-label">{row.label}</td><td className="plugin-kv-value">{row.value}</td></tr>)}</tbody></table>
      {!!view.omitted && <div className="plugin-view-omitted">… {view.omitted} rows omitted</div>}
    </div>;
    case "list": return <div className="plugin-view plugin-view-list" data-testid="plugin-view-list">
      {view.title && <h3 className="plugin-view-title">{view.title}</h3>}
      <ul className="plugin-list">{view.items.map((item, index) => <ListItemRow key={index} item={item} />)}</ul>
      {!!view.omitted && <div className="plugin-view-omitted">… {view.omitted} items omitted</div>}
    </div>;
    case "status": return <div className={`plugin-view plugin-view-status tone-${view.tone}`} data-testid="plugin-view-status"><span className="plugin-status-badge">{view.tone}</span><span className="plugin-status-text">{view.text}</span></div>;
    case "graph": return <div className="plugin-view plugin-view-graph" data-testid="plugin-view-graph">
      {view.title && <h3 className="plugin-view-title">{view.title}</h3>}
      <GraphRows rows={buildGraphRows(view)} />
      {!!view.omitted && <div className="plugin-view-omitted">… {view.omitted} nodes/edges omitted</div>}
    </div>;
    default: return <div className="plugin-unknown-view"><p>Unknown view format</p></div>;
  }
}
