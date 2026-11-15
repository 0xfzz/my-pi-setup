import assert from "node:assert/strict";
import test from "node:test";
import type { GraphWebView } from "../../core/plugin-contracts/view.ts";
import { fitRoutingViewport, routingLayout, zoomRoutingViewport } from "./routing-layout.ts";

const graph: GraphWebView = {
  type: "graph",
  nodes: [
    { id: "route", label: "router/auto", kind: "parent" },
    { id: "target:0", label: "primary/main", status: "neutral" },
    { id: "target:1", label: "backup/other", status: "active" },
    { id: "issue:0", label: "Cache warning", kind: "review", status: "blocked" },
  ],
  edges: [{ from: "route", to: "target:0", label: "1" }, { from: "route", to: "target:1", label: "2" }],
};

test("routing fans out as curved hub-to-model connections, not tree rows or policy cards", () => {
  const layout = routingLayout(graph);
  assert.deepEqual(layout.nodes.map(node => node.id), ["route", "target:0", "target:1"]);
  assert.equal(layout.edges.filter(edge => edge.active).length, 1);
  assert.equal(layout.edges.find(edge => edge.to === "target:0")?.active, false);
  assert.equal(layout.edges.find(edge => edge.to === "target:1")?.active, true);
  assert.ok(layout.edges.every(edge => edge.from === "route" && edge.path.includes(" C ")));
  assert.ok(layout.nodes[0].x < layout.nodes[1].x);
  assert.ok(layout.nodes[1].y < layout.nodes[0].y && layout.nodes[2].y > layout.nodes[0].y);
  for (const node of layout.nodes) {
    assert.ok(node.x >= 0 && node.x + node.width <= layout.width);
    assert.ok(node.y >= 0 && node.y + node.height <= layout.height);
  }
});

test("a live target switch changes the highlighted curve without moving nodes", () => {
  const next = { ...graph, nodes: graph.nodes.map(node => ({ ...node,
    status: node.id === "target:0" ? "active" as const : "neutral" as const,
  })) };
  const before = routingLayout(graph);
  const after = routingLayout(next);
  assert.deepEqual(after.nodes.map(({ x, y }) => [x, y]), before.nodes.map(({ x, y }) => [x, y]));
  assert.equal(after.edges.find(edge => edge.active)?.to, "target:0");
});

test("no decision yet never invents an active model branch", () => {
  const layout = routingLayout({ ...graph, nodes: graph.nodes.map(node => ({ ...node, status: "neutral" })) });
  assert.equal(layout.edges.some(edge => edge.active), false);
  assert.equal(layout.edges.some(edge => edge.to === "output"), false);
  assert.equal(layout.nodes.filter(node => node.role === "target").length, 2);
});

test("an empty route graph remains a readable informational node", () => {
  const layout = routingLayout({ type: "graph", nodes: [{ id: "none", label: "Select a route model" }], edges: [] });
  assert.equal(layout.nodes.length, 1);
  assert.equal(layout.edges.length, 0);
});

test("the reference-style fan with eleven targets keeps every pill separate and visible", () => {
  const nodes: GraphWebView["nodes"] = [graph.nodes[0], ...Array.from({ length: 11 }, (_, index) => ({
    id: `target:${index}`, label: `provider/model-${index}`, status: index === 4 ? "active" as const : "neutral" as const,
  }))];
  const layout = routingLayout({ ...graph, nodes });
  assert.equal(layout.edges.length, 11);
  assert.equal(layout.edges.find(edge => edge.active)?.to, "target:4");
  const pills = layout.nodes.filter(node => node.role === "target");
  for (let index = 1; index < pills.length; index++) assert.ok(pills[index].y > pills[index - 1].y + pills[index - 1].height);
  const fit = fitRoutingViewport({ width: 350, height: 700 }, layout);
  assert.ok(fit.y + layout.height * fit.scale <= 700);
});

test("fit contains the diagram in narrow and wide sidebars", () => {
  for (const width of [280, 420, 700]) {
    const layout = routingLayout(graph);
    const fit = fitRoutingViewport({ width, height: 540 }, layout);
    assert.ok(fit.x >= 0 && fit.y >= 0);
    assert.ok(fit.x + layout.width * fit.scale <= width);
    assert.ok(fit.y + layout.height * fit.scale <= 540);
  }
});

test("zoom preserves the anchor and clamps repeated zoom input", () => {
  const viewport = { x: 10, y: 20, scale: 1 };
  const anchor = { x: 100, y: 200 };
  const zoom = zoomRoutingViewport(viewport, { factor: 2, anchor });
  assert.equal((anchor.x - zoom.x) / zoom.scale, (anchor.x - viewport.x) / viewport.scale);
  assert.equal((anchor.y - zoom.y) / zoom.scale, (anchor.y - viewport.y) / viewport.scale);
  assert.equal(zoomRoutingViewport(viewport, { factor: 100, anchor }).scale, 2);
  assert.equal(zoomRoutingViewport(viewport, { factor: 0.001, anchor }).scale, 0.2);
});
