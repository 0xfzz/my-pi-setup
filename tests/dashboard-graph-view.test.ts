import test from "node:test";
import assert from "node:assert/strict";

import { delegationToGraphView } from "../lib/dashboard/graph-view.ts";
import { validateView } from "../lib/web-plugins/view.ts";
import type { DashboardSnapshot } from "../lib/dashboard/protocol.ts";

const snapshot = (over: Partial<DashboardSnapshot["delegation"]> = {}, session = { id: "s1", name: "Dashboard polish", mode: "normal", project: "/repo" }): DashboardSnapshot => ({
  session,
  delegation: {
    children: [],
    handoffs: [],
    reviews: [],
    escalations: [],
    specReviews: [],
    paused: false,
    ...over,
  },
  artifacts: [],
});

test("the graph view carries the parent, each child, and handoff-labelled edges", () => {
  const view = delegationToGraphView(snapshot({
    children: [
      {
        id: "c1", name: "worker-slots", scope: "slots", status: "running", purpose: "implementation",
        task: "Port the slot adapters", handoffId: "h1", laneFiles: ["vendor/pi-web/components/plugins/slots/TopSlotAdapter.tsx"],
        lastMilestoneFiles: [], lastTokens: 18_400, lastContextWindow: 200_000,
      },
      { id: "c2", name: "reviewer", scope: "review", status: "completed", laneFiles: [], lastMilestoneFiles: [] },
    ],
    handoffs: [
      { id: "h1", scope: "slots", goal: "Port slot adapters to the shared layout coordinator", acceptanceCriteria: ["e2e passes", "tidy passes"] },
    ],
  }));
  assert.equal(view.type, "graph");
  if (view.type !== "graph") return;
  assert.equal(view.title, "Dashboard polish");
  assert.deepEqual(view.nodes.map(n => [n.id, n.kind, n.status]), [
    ["parent", "parent", "active"],
    ["child:c1", "child", "active"],
    ["child:c2", "child", "done"],
  ]);
  assert.deepEqual(view.edges, [
    { from: "parent", to: "child:c1", label: "Port slot adapters to the shared layout coordinator" },
    { from: "parent", to: "child:c2" },
  ]);
  const detail = view.nodes[1].detail ?? "";
  assert.match(detail, /\*\*Status:\*\* running/);
  assert.match(detail, /\*\*Task:\*\* Port the slot adapters/);
  assert.match(detail, /\*\*Handoff:\*\* Port slot adapters/);
  assert.match(detail, /\*\*Context:\*\* 18,400 tokens of 200,000/);
  assert.match(detail, /\*\*Acceptance:\*\*[\s\S]*- e2e passes/);
  assert.match(detail, /TopSlotAdapter\.tsx/);
  assert.equal(validateView(view).ok, true);
});

test("reviews and escalations attach to the child they judged, or the parent", () => {
  const view = delegationToGraphView(snapshot({
    children: [
      { id: "c1", name: "worker", scope: "slots", status: "failed", laneFiles: [], lastMilestoneFiles: [], closeReason: "tests red" },
    ],
    reviews: [{ id: "r1", scope: "slots", verdict: "changes-requested", summary: "Rework the adapter seam" }],
    escalations: [{ id: "e1", childId: "c1", question: "Which seam?", stage: "answer" }],
  }));
  assert.equal(view.type, "graph");
  if (view.type !== "graph") return;
  const edges = view.edges.map(e => `${e.from}->${e.to}`);
  assert.ok(edges.includes("child:c1->review:r1"), "a review of a child's scope attaches to that child");
  assert.ok(edges.includes("child:c1->escalation:e1"), "an escalation with childId attaches to that child");
  const review = view.nodes.find(n => n.id === "review:r1");
  assert.equal(review?.status, "failed");
  assert.match(review?.detail ?? "", /\*\*Verdict:\*\* changes-requested/);
  const escalation = view.nodes.find(n => n.id === "escalation:e1");
  assert.equal(escalation?.kind, "escalation");
  const failedChild = view.nodes.find(n => n.id === "child:c1");
  assert.equal(failedChild?.status, "failed");
  assert.match(failedChild?.detail ?? "", /\*\*Close:\*\* tests red/);
});

test("spec reviews are parent-attached review nodes", () => {
  const view = delegationToGraphView(snapshot({
    specReviews: [{ id: "sr1", title: "Pluggable UI spec", status: "accepted", reviewerIds: ["reviewer-a"] }],
  }));
  assert.equal(view.type, "graph");
  if (view.type !== "graph") return;
  const node = view.nodes.find(n => n.id === "spec:sr1");
  assert.equal(node?.kind, "review");
  assert.equal(node?.status, "done");
  assert.deepEqual(view.edges, [{ from: "parent", to: "spec:sr1", label: "spec review" }]);
});

test("an empty snapshot is a lone neutral parent, and a paused session reads as blocked", () => {
  const empty = delegationToGraphView(snapshot());
  assert.equal(empty.type, "graph");
  if (empty.type === "graph") {
    assert.deepEqual(empty.nodes, [{ id: "parent", label: "Dashboard polish", kind: "parent", status: "neutral" }]);
    assert.deepEqual(empty.edges, []);
  }
  const paused = delegationToGraphView(snapshot({ paused: true }));
  assert.equal(paused.type, "graph");
  if (paused.type === "graph") assert.equal(paused.nodes[0].status, "blocked");

  const unnamed = delegationToGraphView(snapshot(undefined, { id: "s9", name: "", mode: "normal", project: "/repo" }));
  assert.equal(unnamed.type, "graph");
  if (unnamed.type === "graph") assert.equal(unnamed.nodes[0].label, "Session");
  assert.equal(delegationToGraphView(null).type, "graph", "a null snapshot still yields a view");
});

test("node and edge caps report omissions instead of failing", () => {
  const view = delegationToGraphView(snapshot({
    children: Array.from({ length: 130 }, (_, i) => ({ id: `c${i}`, name: `worker-${i}`, scope: `s${i}`, status: "running" as const, laneFiles: [], lastMilestoneFiles: [] })),
  }));
  assert.equal(view.type, "graph");
  if (view.type !== "graph") return;
  assert.equal(view.nodes.length, 100, "nodes capped at 100");
  assert.equal(view.edges.length, 99, "edges lose only the dropped nodes' edges");
  assert.ok((view.omitted ?? 0) >= 30, "omissions are visible");
  for (const edge of view.edges) {
    assert.ok(view.nodes.some(n => n.id === edge.from) && view.nodes.some(n => n.id === edge.to), "every edge references a declared node");
  }
});
