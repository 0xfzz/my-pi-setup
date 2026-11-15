import { useEffect, useMemo, useState } from "react";
import { ArrowsOut, Minus, Plus, X } from "@phosphor-icons/react";
import type { GraphNode, GraphWebView } from "../../core/plugin-contracts/view.ts";
import type { HostPanelProps } from "../../core/client/plugin-system/panel-registry.tsx";
import { routingLayout, type RoutingLayout, type RoutingNode } from "./routing-layout.ts";
import { useRoutingViewport } from "./use-routing-viewport.ts";

function NodeLabel({ node }: { node: RoutingNode }) {
  const separator = node.label.indexOf("/");
  return separator > 0 ? <>
    <strong>{node.label.slice(separator + 1)}</strong>
    <span className="router-node-provider">{node.label.slice(0, separator)}</span>
  </> : <strong>{node.label}</strong>;
}

function RoutingEdges({ graph }: { graph: RoutingLayout }) {
  return <svg className="router-edges" width={graph.width} height={graph.height} aria-hidden="true">
    {[...graph.edges].sort((a, b) => Number(a.active) - Number(b.active)).map(edge => <g key={`${edge.from}-${edge.to}`}>
      <path d={edge.path} className={`router-edge${edge.active ? " is-live" : ""}`}
        data-from={edge.from} data-to={edge.to} data-active={edge.active} />
      {edge.active ? <circle r="3.5" className="router-packet"><animateMotion dur="2.4s" repeatCount="indefinite" path={edge.path} /></circle> : null}
    </g>)}
  </svg>;
}

function RoutingCanvas({ graph, selected, onSelect }: { graph: RoutingLayout; selected?: GraphNode; onSelect: (node: GraphNode) => void }) {
  const { canvas, viewport, fit, zoom, gestures } = useRoutingViewport(graph);
  return <>
    <div className="router-canvas" ref={canvas} {...gestures} aria-label="Interactive routing graph">
    <div className="router-canvas-toolbar" role="toolbar" aria-label="Routing graph controls">
      <button type="button" aria-label="Zoom out" onClick={() => zoom(0.8)}><Minus size={15} /></button>
      <output aria-label="Graph zoom">{Math.round(viewport.scale * 100)}%</output>
      <button type="button" aria-label="Zoom in" onClick={() => zoom(1.25)}><Plus size={15} /></button>
      <button type="button" aria-label="Fit routing graph" onClick={fit}><ArrowsOut size={15} /></button>
    </div>
      <div className="router-stage" data-testid="routing-stage" style={{ width: graph.width, height: graph.height, transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}>
        <RoutingEdges graph={graph} />
        {graph.nodes.map(node => <button type="button" key={node.id}
          className={`router-graph-node router-node-${node.role}${node.status === "active" ? " is-live" : ""}`}
          style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
          aria-label={`Highlight ${node.label}`} aria-pressed={selected?.id === node.id} data-node-id={node.id} data-status={node.status ?? "neutral"}
          title={`${node.label}${node.detail ? `\n${node.detail}` : ""}`} onClick={() => onSelect(node)}><NodeLabel node={node} /></button>)}
      </div>
      <span className="router-gesture-hint">Drag to pan · scroll to zoom</span>
    </div>
  </>;
}

function RoutingDiagram({ view }: { view: GraphWebView }) {
  const graph = useMemo(() => routingLayout(view), [view]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const active = graph.nodes.find(node => node.role === "target" && node.status === "active");
  const selected = graph.nodes.find(node => node.id === selectedId);
  return <>
    <span className="sr-only" role="status" aria-live="polite">{active ? `Current target: ${active.label}` : "Waiting for a routing decision"}</span>
    <RoutingCanvas graph={graph} selected={selected} onSelect={node => setSelectedId(node.id)} />

  </>;
}

export function RouterPanel({ open, onClose, sessionId, view }: HostPanelProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);
  if (!open) return null;
  const routeIdentity = view?.type === "graph" ? view.nodes.find(node => node.id === "route")?.label : "none";
  return <>
    <div className="app-side-panel-scrim" onClick={onClose} aria-hidden="true" />
    <aside id="plugin-side-panel" className="app-side-panel router-panel" role="complementary" aria-label="Router panel">
      <div className="app-side-panel-header"><span className="app-side-panel-title">Router <span className="router-header-tag">LIVE</span></span>
        <button type="button" className="app-side-panel-action-btn" onClick={onClose} aria-label="Close panel"><X size={16} /></button>
      </div>
      <div className="app-side-panel-body router-panel-body">
        {view?.type === "graph" ? <RoutingDiagram key={`${sessionId}/${routeIdentity}`} view={view} /> : <p>Select a route model to visualize its decisions.</p>}
      </div>
    </aside>
  </>;
}
