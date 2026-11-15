import type { GraphNode, GraphWebView } from "../../core/plugin-contracts/view.ts";

export interface RoutingNode extends GraphNode {
  role: "input" | "target";
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RoutingEdge {
  from: string;
  to: string;
  path: string;
  active: boolean;
}

export interface RoutingLayout {
  nodes: RoutingNode[];
  edges: RoutingEdge[];
  width: number;
  height: number;
}

export interface RoutingViewport { x: number; y: number; scale: number }
interface Size { width: number; height: number }

const WIDTH = 360;
const PADDING = 32;
const TARGET_HEIGHT = 48;
const TARGET_GAP = 72;
const HUB_HEIGHT = 78;

/** Left-hand hub, smooth fan-out, right-hand model pills. Positions stay stable on live updates. */
export function routingLayout(view: GraphWebView): RoutingLayout {
  const root = view.nodes.find(node => node.id === "route") ?? view.nodes[0];
  const targets = view.nodes.filter(node => node.id.startsWith("target:"));
  const height = Math.max(420, PADDING * 2 + (targets.length - 1) * TARGET_GAP + TARGET_HEIGHT);
  if (!root) return { nodes: [], edges: [], width: WIDTH, height };
  const hub: RoutingNode = { ...root, role: "input", x: targets.length ? 20 : 60, y: (height - HUB_HEIGHT) / 2, width: targets.length ? 110 : 240, height: HUB_HEIGHT };
  const gap = targets.length > 1 ? (height - PADDING * 2 - TARGET_HEIGHT) / (targets.length - 1) : 0;
  const pills: RoutingNode[] = targets.map((node, index) => ({
    ...node, role: "target", x: 196, y: targets.length === 1 ? (height - TARGET_HEIGHT) / 2 : PADDING + index * gap, width: 144, height: TARGET_HEIGHT,
  }));
  const edges = pills.map(node => ({
    from: hub.id, to: node.id, active: node.status === "active",
    path: `M ${hub.x + hub.width} ${height / 2} C 164 ${height / 2}, 160 ${node.y + TARGET_HEIGHT / 2}, ${node.x - 8} ${node.y + TARGET_HEIGHT / 2}`,
  }));
  return { nodes: [hub, ...pills], edges, width: WIDTH, height };
}

export function fitRoutingViewport(size: Size, graph: Size): RoutingViewport {
  const padding = 16;
  const scale = Math.max(0.01, Math.min(1.5, (size.width - padding * 2) / graph.width, (size.height - padding * 2) / graph.height));
  return { scale, x: (size.width - graph.width * scale) / 2, y: (size.height - graph.height * scale) / 2 };
}

export function zoomRoutingViewport(viewport: RoutingViewport, options: { factor: number; anchor: { x: number; y: number } }): RoutingViewport {
  const scale = Math.min(2, Math.max(0.2, viewport.scale * options.factor));
  const ratio = scale / viewport.scale;
  return { scale, x: options.anchor.x - (options.anchor.x - viewport.x) * ratio, y: options.anchor.y - (options.anchor.y - viewport.y) * ratio };
}
