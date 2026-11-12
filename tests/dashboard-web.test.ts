import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDot,
  describeNode,
  filterArtifacts,
  projectGraph,
  topologySignature,
} from "../web/core/dashboard/src/graph.mjs";
import {
  escapeDotString,
  isSafeLinkUrl,
  renderMarkdownSafe,
  sanitizeSvgMarkup,
  stripActiveMarkup,
} from "../web/core/dashboard/src/sanitize.mjs";
import * as S from "../web/core/dashboard/src/state.mjs";
import * as GraphModel from "../web/core/dashboard/src/graph.mjs";
import { ApiError, createApi, createChangeCoalescer, parseChangeEvent } from "../web/core/dashboard/src/api.mjs";
import { renderDot } from "../web/core/dashboard/src/graphviz.mjs";
import { decorateGraphSvg, graphNodeFromEvent, selectGraphNode, updateGraphSvg } from "../web/core/dashboard/src/graph-dom.mjs";
import { MOTION, planGraphMotion, staggerDelayMs } from "../web/core/dashboard/src/motion.mjs";

type Any = any;

// The new model-layer exports are consumed through a loose view so this suite does
// not depend on hand-written `.d.mts` declarations owned by another work unit.
const graphModel: Any = GraphModel;
const stateModel: Any = S;

function artifact(id: string, title: string, overrides: Record<string, Any> = {}) {
  return {
    id,
    title,
    type: "spec",
    version: 1,
    createdBy: "worker",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    tags: [],
    ...overrides,
  };
}

function makeView(overrides: Record<string, Any> = {}) {
  return {
    session: { id: "s1", name: "Session One", project: "pi-workflow-extensions", mode: "normal", branchId: "b1" },
    connected: true,
    lastSeen: 1_000,
    revision: 7,
    delegation: {
      children: [
        {
          id: "c1",
          name: "api-worker",
          scope: "api",
          status: "running",
          purpose: "implementation",
          handoffId: "h1",
          reviewRunId: "sr1",
          laneFiles: ["src/api.ts"],
          lastMilestoneFiles: ["src/api.ts"],
          artifactIds: ["a-owned"],
          startedAt: 1,
          task: "Implement API",
        },
        { id: "c2", name: "done-worker", scope: "ui", status: "completed", purpose: "implementation", startedAt: 2, handoffId: "h2" },
        { id: "c3", name: "closed-worker", scope: "docs", status: "closed", startedAt: 3 },
        {
          id: "c4",
          name: "reviewer",
          scope: "api",
          status: "running",
          purpose: "review",
          reviewRunId: "sr1",
          supersededIds: ["c2"],
          startedAt: 4,
        },
      ],
      handoffs: [
        { id: "h1", scope: "api", goal: "API handoff", acceptanceCriteria: ["x"] },
        { id: "h2", scope: "ui", goal: "UI handoff", acceptanceCriteria: [] },
      ],
      reviews: [{ id: "r1", scope: "api", verdict: "approved", summary: "looks good", timestamp: "2026-01-03T00:00:00.000Z" }],
      escalations: [{ id: "e1", childId: "c1", scope: "api", question: "Which endpoint?", stage: "blocked" }],
      specReviews: [{ id: "sr1", title: "API spec", status: "ready", reviewerIds: ["c4", "cX"] }],
      paused: false,
    },
    artifacts: [
      artifact("a-owned", "Owned artifact", { scope: "api", childId: "c1", version: 2 }),
      artifact("a-unowned", "Session notes", { scope: "api" }),
      artifact("a-done", "Done artifact", { type: "code", scope: "ui", childId: "c2" }),
    ],
    ...overrides,
  };
}

function makeSessions() {
  return [
    { id: "s-old", name: "Old", project: "p", mode: "normal", connected: false, lastSeen: 500, revision: 2, workers: { running: 0, total: 1 } },
    { id: "s1", name: "Session One", project: "p", mode: "normal", connected: true, lastSeen: 900, revision: 7, workers: { running: 1, total: 2 } },
  ];
}

async function makeDom() {
  const { JSDOM } = await import("jsdom");
  const window = new JSDOM("<!doctype html><html><body></body></html>").window;
  (globalThis as Any).window = window;
  const createDOMPurify = ((await import("dompurify")) as Any).default;
  const DOMPurify = createDOMPurify(window);
  return { window, DOMPurify, cleanup: () => { window.close(); delete (globalThis as Any).window; } };
}

/* ------------------------------------------------------------ projection */

test("projects explicit topology and provenance-based artifact associations", () => {
  const view = makeView();
  const graph = projectGraph(view);
  const ids = graph.nodes.map((node: Any) => node.id);
  for (const id of [
    "session:s1",
    "child:c1",
    "child:c2",
    "child:c3",
    "child:c4",
    "handoff:h1",
    "handoff:h2",
    "review:r1",
    "spec-review:sr1",
    "escalation:e1",
  ]) {
    assert.ok(ids.includes(id), `missing node ${id}`);
  }

  const edge = (from: string, to: string, kind: string) =>
    graph.edges.some((candidate: Any) => candidate.from === from && candidate.to === to && candidate.kind === kind);
  assert.ok(edge("session:s1", "child:c1", "spawn"));
  assert.ok(edge("child:c1", "handoff:h1", "handoff"));
  assert.ok(edge("child:c1", "spec-review:sr1", "review"));
  assert.ok(edge("child:c4", "child:c2", "supersedes"));
  assert.ok(edge("child:c1", "escalation:e1", "escalation"));
  assert.ok(edge("session:s1", "review:r1", "verdict"));

  // Explicit childId wins; a matching scope alone must never associate.
  const childOne = graph.associations["child:c1"].map((summary: Any) => summary.id);
  assert.deepEqual(childOne.sort(), ["a-owned"]);
  const sessionArtifacts = graph.associations["session:s1"].map((summary: Any) => summary.id);
  assert.deepEqual(sessionArtifacts, ["a-unowned"]);
  const childTwo = graph.associations["child:c2"].map((summary: Any) => summary.id);
  assert.deepEqual(childTwo, ["a-done"]);

  const childNode = graph.nodes.find((node: Any) => node.id === "child:c1");
  const described = describeNode(childNode, { artifacts: graph.associations["child:c1"] });
  assert.ok(described);
  assert.equal(described?.kindLabel, "Worker");
  assert.equal(described?.statusLabel, "Running");
  assert.equal(described?.handoffId, "h1");
  assert.deepEqual(described?.artifacts.map((entry: Any) => entry.id), ["a-owned"]);
  // Handoffs inherit their workers' explicit child provenance only; scope alone
  // (a-unowned carries scope "api", h1's scope) must never associate.
  assert.deepEqual(graph.associations["handoff:h1"].map((summary: Any) => summary.id), ["a-owned"]);
});

test("hiding completed workers prunes their edges, orphan nodes and keeps stable ids", () => {
  const graph = projectGraph(makeView(), { hideCompleted: true });
  const ids = graph.nodes.map((node: Any) => node.id);
  assert.ok(!ids.includes("child:c2"));
  assert.ok(!ids.includes("child:c3"));
  assert.ok(!ids.includes("handoff:h2"), "handoff only referenced by a hidden worker is pruned");
  assert.ok(!graph.edges.some((edge: Any) => edge.to === "child:c2" || edge.from === "child:c2"));
  assert.ok(ids.includes("child:c1"));
  assert.equal(graph.counts.completed, 1, "counts still describe the full session");
  assert.equal(graph.counts.children, 4);

  const again = projectGraph(makeView(), { hideCompleted: true });
  assert.deepEqual(again.nodes.map((node: Any) => node.dotId), graph.nodes.map((node: Any) => node.dotId));
  assert.deepEqual(again.edges.map((edge: Any) => edge.dotId), graph.edges.map((edge: Any) => edge.dotId));
});

test("topology signature ignores status and includes labels/edges", () => {
  const first = projectGraph(makeView());
  const statusChanged = makeView();
  statusChanged.delegation.children[0].status = "blocked";
  const second = projectGraph(statusChanged);
  assert.equal(topologySignature(first), topologySignature(second));

  // A slug-shaped name is replaced by a dictionary name, so renaming a slug is not
  // a topology change; an explicit human name and a scope change both are.
  const slugRename = makeView();
  slugRename.delegation.children[0].name = "renamed-worker";
  assert.equal(topologySignature(first), topologySignature(projectGraph(slugRename)));

  const humanRename = makeView();
  humanRename.delegation.children[0].name = "Wayan Kusuma";
  assert.notEqual(topologySignature(first), topologySignature(projectGraph(humanRename)));

  const scopeChanged = makeView();
  scopeChanged.delegation.children[0].scope = "api-v2";
  assert.notEqual(topologySignature(first), topologySignature(projectGraph(scopeChanged)));

  const added = makeView();
  added.delegation.children.push({ id: "c5", name: "new-worker", scope: "x", status: "running", startedAt: 9 });
  assert.notEqual(topologySignature(first), topologySignature(projectGraph(added)));
});

test("DOT labels are escaped and stable regardless of input order", () => {
  // Escaping is a property of the writer, so feed it the hostile label directly.
  const hostile = buildDot({
    nodes: [{ id: "n1", dotId: "n1", kind: "child", label: 'bad "quoted" \\ slash', status: "running" }],
    edges: [],
  } as Any);
  assert.ok(hostile.includes('\\"quoted\\"'), "double quotes must be escaped");
  assert.ok(hostile.includes("\\\\ slash"), "backslashes must be escaped so DOT escapes stay literal");
  for (const line of hostile.split("\n")) {
    if (!line.includes('label="')) continue;
    assert.ok(!line.includes("\\n"), "labels must not inject DOT newline escapes");
  }

  // Projected labels stay byte-stable regardless of the order rows arrive in.
  const view = makeView();
  view.delegation.children[0].name = "api-worker";
  const dot = buildDot(projectGraph(view));
  const reversed = makeView();
  reversed.delegation.children.reverse();
  reversed.delegation.handoffs.reverse();
  const normalize = (text: string) => text.replace(/^.*$/gm, (line: string) => line.trim()).split("\n").sort().join("\n");
  assert.equal(normalize(buildDot(projectGraph(reversed))), normalize(dot));

  assert.equal(escapeDotString("a\nb\tc"), "a b c");
});

test("artifact catalog search matches id/title/type/tags/scope and sorts newest first", () => {
  const summaries = [
    artifact("a1", "API contract", { tags: ["backend"], updatedAt: "2026-01-01T00:00:00.000Z" }),
    artifact("a2", "UI notes", { scope: "ui", type: "note", updatedAt: "2026-02-01T00:00:00.000Z" }),
    artifact("a3", "Backend plan", { tags: ["api", "plan"], updatedAt: "2026-03-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(filterArtifacts(summaries, "api").map((entry: Any) => entry.id), ["a3", "a1"]);
  assert.deepEqual(filterArtifacts(summaries, "ui note").map((entry: Any) => entry.id), ["a2"]);
  assert.deepEqual(filterArtifacts(summaries, "").map((entry: Any) => entry.id), ["a3", "a2", "a1"]);
  assert.deepEqual(filterArtifacts(summaries, "missing"), []);
});

/* ------------------------------------------------------ handoff detail model */

test("describeNode exposes handoff goal and acceptance criteria without truncating to the sublabel", () => {
  const view = makeView();
  view.delegation.handoffs[0] = {
    id: "h1",
    scope: "api",
    goal: `Deliver the dashboard detail drawer ${"x".repeat(4000)}`,
    acceptanceCriteria: [
      "Ship the drawer",
      "z".repeat(500),
      ...Array.from({ length: 60 }, (_, index) => `check ${index + 1}`),
    ],
  };
  const graph = projectGraph(view);
  const node = graph.nodes.find((candidate: Any) => candidate.id === "handoff:h1")!;
  const described: Any = describeNode(node);

  assert.equal(described?.goal.length, 4000, "the full goal survives, capped at 4000 characters");
  assert.ok(described?.goal.startsWith("Deliver the dashboard detail drawer"), "goal is the handoff goal");
  assert.ok(described?.goal.endsWith("…"));
  assert.ok((node.sublabel || "").length <= 80, "the graph sublabel stays short");
  assert.notEqual(described?.goal, node.sublabel, "the goal is not the truncated sublabel");

  const criteria = described?.acceptanceCriteria || [];
  assert.equal(criteria.length, 50, "acceptance criteria are capped at 50 items");
  assert.equal(criteria[0], "Ship the drawer");
  assert.equal(criteria[1].length, 400, "each criterion is capped at 400 characters");
  assert.ok(criteria[1].endsWith("…"));
  assert.equal(criteria[criteria.length - 1], "check 48");

  // Non-handoff nodes never borrow handoff fields.
  const child: Any = describeNode(graph.nodes.find((candidate: Any) => candidate.id === "child:c1")!);
  assert.equal(child?.goal, "");
  assert.deepEqual(child?.acceptanceCriteria, []);
  assert.deepEqual(child?.workers, []);

  const bare: Any = describeNode({ ...node, raw: { id: "h9", scope: "api" } });
  assert.equal(bare?.goal, "");
  assert.deepEqual(bare?.acceptanceCriteria, []);
});

test("handoff nodes resolve workers by handoffId only and derive their status", () => {
  const view = makeView();
  view.delegation.children.push({ id: "c-lookalike", name: "same-scope", scope: "api", status: "running", startedAt: 6 } as Any);
  const graph = projectGraph(view);
  const h1: Any = graph.nodes.find((candidate: Any) => candidate.id === "handoff:h1")!;
  const h2: Any = graph.nodes.find((candidate: Any) => candidate.id === "handoff:h2")!;

  assert.deepEqual(h1.workers.map((worker: Any) => worker.id), ["child:c1"], "scope alone never attaches a worker");
  assert.deepEqual(h2.workers.map((worker: Any) => worker.id), ["child:c2"]);
  assert.equal(h1.status, "running");
  assert.equal(h2.status, "completed");

  const described: Any = describeNode(h1)!;
  assert.deepEqual(described.workers.map((worker: Any) => worker.id), ["child:c1"]);
  assert.match(described.workers[0].label, /^[A-Za-z]+ · .+ Builder$/, "a worker label is a person plus a role");
  assert.ok(!described.workers[0].label.includes("api-worker"), "the raw slug is never shown as a person");
  assert.equal(described.workers[0].status, "running");
  const review: Any = describeNode(graph.nodes.find((candidate: Any) => candidate.id === "review:r1")!);
  assert.deepEqual(review?.workers, [], "workers live on handoffs only");
});

test("hidden completed workers stay in handoff detail without becoming graph nodes", () => {
  const view = makeView();
  view.delegation.children.push({ id: "c5", name: "old-worker", scope: "api", status: "closed", handoffId: "h1", startedAt: 5 } as Any);
  const graph = projectGraph(view, { hideCompleted: true });
  const ids = graph.nodes.map((node: Any) => node.id);
  assert.ok(!ids.includes("child:c5"), "hidden workers are not resurrected as nodes");
  const h1: Any = graph.nodes.find((candidate: Any) => candidate.id === "handoff:h1")!;
  assert.deepEqual(h1.workers.map((worker: Any) => worker.id), ["child:c1", "child:c5"], "the drawer still lists every attached worker");
  assert.equal(h1.status, "running");
});

/* ------------------------------------------- handoff artifact inheritance */

test("handoff nodes inherit the artifacts produced by their own workers", () => {
  const view = makeView();
  const graph = projectGraph(view);
  const h1: Any = graph.nodes.find((candidate: Any) => candidate.id === "handoff:h1")!;
  const h2: Any = graph.nodes.find((candidate: Any) => candidate.id === "handoff:h2")!;

  assert.deepEqual(graph.associations["handoff:h1"].map((summary: Any) => summary.id), ["a-owned"]);
  assert.deepEqual(graph.associations["handoff:h2"].map((summary: Any) => summary.id), ["a-done"]);
  assert.deepEqual(h1.artifactIds, ["a-owned"], "handoff artifactIds are materialised like child/session ids");
  assert.deepEqual(h2.artifactIds, ["a-done"]);

  const described: Any = describeNode(h1, { artifacts: graph.associations["handoff:h1"] });
  assert.deepEqual(described?.artifacts, [{
    id: "a-owned",
    title: "Owned artifact",
    type: "spec",
    version: 2,
    updatedAt: "2026-01-02T00:00:00.000Z",
  }]);
});

test("handoff artifact inheritance dedups shared ids and sorts newest first", () => {
  const view = makeView();
  view.delegation.children.push({
    id: "c5",
    name: "api-reviewer",
    scope: "api",
    status: "running",
    handoffId: "h1",
    artifactIds: ["a-owned", "a-shared"],
    startedAt: 5,
  } as Any);
  view.artifacts.push(artifact("a-shared", "Shared artifact", {
    childId: "c5",
    updatedAt: "2026-02-01T00:00:00.000Z",
  }));

  const graph = projectGraph(view);
  const ids = graph.associations["handoff:h1"].map((summary: Any) => summary.id);
  assert.deepEqual(ids, ["a-shared", "a-owned"], "shared id appears once, newest first");
  assert.equal(ids.filter((id: string) => id === "a-owned").length, 1);
  assert.deepEqual(
    graph.nodes.find((candidate: Any) => candidate.id === "handoff:h1")!.artifactIds,
    ["a-shared", "a-owned"],
  );
});

test("handoffs without workers or without worker artifacts get no association entry", () => {
  const view = makeView();
  view.delegation.handoffs.push({ id: "h-bare", scope: "api", goal: "no workers", acceptanceCriteria: [] });
  view.delegation.handoffs.push({ id: "h-idle", scope: "api", goal: "worker without artifacts", acceptanceCriteria: [] });
  view.delegation.children.push({ id: "c-idle", name: "idle-worker", scope: "api", status: "running", handoffId: "h-idle", startedAt: 6 } as Any);

  const graph = projectGraph(view);
  assert.equal(Object.hasOwn(graph.associations, "handoff:h-bare"), false, "no workers means no key, not an empty array");
  assert.equal(Object.hasOwn(graph.associations, "handoff:h-idle"), false, "workers without artifacts mean no key");
  const idle: Any = graph.nodes.find((candidate: Any) => candidate.id === "handoff:h-idle")!;
  assert.deepEqual(idle.artifactIds, []);
  assert.deepEqual(describeNode(idle, { artifacts: graph.associations["handoff:h-idle"] })?.artifacts, []);
});

test("handoff artifacts never come from scope alone", () => {
  const view = makeView();
  // a-unowned already carries scope "api" with no child provenance; a-lookalike
  // is owned by a same-scope worker that is not attached to h1.
  view.delegation.children.push({
    id: "c-lookalike",
    name: "same-scope",
    scope: "api",
    status: "running",
    artifactIds: ["a-lookalike"],
    startedAt: 6,
  } as Any);
  view.artifacts.push(artifact("a-lookalike", "Lookalike artifact", { scope: "api", childId: "c-lookalike" }));
  view.delegation.handoffs.push({ id: "h-scope", scope: "api", goal: "scope only", acceptanceCriteria: [] });

  const graph = projectGraph(view);
  assert.deepEqual(graph.associations["handoff:h1"].map((summary: Any) => summary.id), ["a-owned"]);
  assert.equal(Object.hasOwn(graph.associations, "handoff:h-scope"), false, "a matching scope never associates an artifact");
});

test("hiding completed workers leaves handoff artifact provenance unchanged", () => {
  const view = makeView();
  view.delegation.children.push({
    id: "c5",
    name: "old-worker",
    scope: "api",
    status: "closed",
    handoffId: "h1",
    artifactIds: ["a-closed"],
    startedAt: 5,
  } as Any);
  view.artifacts.push(artifact("a-closed", "Closed artifact", {
    childId: "c5",
    updatedAt: "2026-03-01T00:00:00.000Z",
  }));

  const full = projectGraph(view);
  const hidden = projectGraph(view, { hideCompleted: true });
  assert.ok(!hidden.nodes.some((node: Any) => node.id === "child:c5"), "the worker node itself is pruned");
  assert.deepEqual(
    hidden.associations["handoff:h1"].map((summary: Any) => summary.id),
    ["a-closed", "a-owned"],
    "visible handoff keeps a pruned worker's artifact",
  );
  assert.deepEqual(hidden.associations, full.associations, "hiding adds and removes no association");
  const h1: Any = hidden.nodes.find((node: Any) => node.id === "handoff:h1")!;
  assert.deepEqual(h1.artifactIds, ["a-closed", "a-owned"]);
  assert.ok(!hidden.associations["handoff:h1"].some((summary: Any) => summary.id === "a-done"), "other workers' artifacts never leak in");
});

test("handoffStatusFor derives handoff status from attached workers", () => {
  const worker = (id: string, status: string, handoffId: string | null) => ({ id, status, handoffId });
  assert.equal(graphModel.handoffStatusFor("h1", []), "pending", "a handoff without workers is pending");
  assert.equal(graphModel.handoffStatusFor("h1", null), "pending");
  assert.equal(graphModel.handoffStatusFor("h1", [worker("a", "running", "h1")]), "running");
  assert.equal(graphModel.handoffStatusFor("h1", [worker("a", "running", "h1"), worker("b", "completed", "h1")]), "running");
  assert.equal(graphModel.handoffStatusFor("h1", [worker("a", "running", "h1"), worker("b", "blocked", "h1")]), "blocked", "one blocked worker outranks running");
  assert.equal(graphModel.handoffStatusFor("h1", [worker("a", "closed", "h1"), worker("b", "failed", "h1")]), "blocked");
  assert.equal(graphModel.handoffStatusFor("h1", [worker("a", "completed", "h1"), worker("b", "closed", "h1")]), "completed");
  assert.equal(graphModel.handoffStatusFor("h1", [worker("a", "paused", "h1")]), "pending");
  assert.equal(graphModel.handoffStatusFor("h1", [worker("a", "running", "h2")]), "pending", "other handoffs never count");
  assert.equal(graphModel.handoffStatusFor(null as Any, [worker("a", "running", null)]), "pending");
});

test("needsAttention flags pings, stuck statuses and escalations", () => {
  const view = makeView();
  (view.delegation.children[0] as Any).pendingPing = true;
  view.delegation.children.push({ id: "c6", name: "stuck", scope: "api", status: "blocked", handoffId: "h1", startedAt: 6 } as Any);
  const graph = projectGraph(view);
  const described = (id: string): Any => describeNode(graph.nodes.find((candidate: Any) => candidate.id === id)!);
  assert.equal(described("child:c1").needsAttention, true, "a pending ping needs a human");
  assert.equal(described("child:c2").needsAttention, false, "completed work is quiet");
  assert.equal(described("child:c4").needsAttention, false);
  assert.equal(described("child:c6").needsAttention, true);
  assert.equal(described("handoff:h1").needsAttention, true, "the handout inherits its stuck worker's status");
  assert.equal(described("escalation:e1").needsAttention, true);
  assert.equal(described("review:r1").needsAttention, false);
});

test("groupWork and workCounts split non-session nodes in graph order", () => {
  const view = makeView();
  (view.delegation.children[0] as Any).pendingPing = true;
  view.delegation.children.push({ id: "c6", name: "stuck", scope: "api", status: "blocked", handoffId: "h1", startedAt: 6 } as Any);
  const graph = projectGraph(view);
  const grouped: Any = graphModel.groupWork(graph);
  const ids = (list: Any[]) => list.map((node: Any) => node.id);

  assert.deepEqual(ids(grouped.attention), ["child:c1", "child:c6", "handoff:h1", "escalation:e1"]);
  assert.deepEqual(ids(grouped.finished), ["child:c2", "child:c3", "handoff:h2", "review:r1"]);
  assert.deepEqual(ids(grouped.active), ["child:c4", "spec-review:sr1"]);
  assert.ok(![...grouped.attention, ...grouped.active, ...grouped.finished].some((node: Any) => node.kind === "session"), "the session is structure, not work");
  for (const node of [...grouped.attention, ...grouped.active, ...grouped.finished]) {
    assert.ok(graph.nodes.includes(node), "grouped nodes are the projected nodes, not copies");
  }

  const counts = graphModel.workCounts(graph);
  assert.deepEqual(counts, { attention: 4, active: 2, finished: 4, total: 10 });
  assert.equal(counts.total, graph.nodes.length - 1, "total counts work nodes only");
  assert.equal(counts.attention, grouped.attention.length);
  assert.equal(counts.active, grouped.active.length);
  assert.equal(counts.finished, grouped.finished.length);

  assert.deepEqual(graphModel.workCounts({ nodes: [] }), { attention: 0, active: 0, finished: 0, total: 0 });
  assert.deepEqual(graphModel.groupWork(null as Any), { attention: [], active: [], finished: [] });
});

/* --------------------------------------------------------------- sanitize */

test("link policy only allows absolute http(s) without credentials", () => {
  for (const url of ["https://example.com/doc", "http://127.0.0.1:8080/x?y=1"]) {
    assert.equal(isSafeLinkUrl(url), true, url);
  }
  for (const url of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "blob:https://example.com/x",
    "//evil.example/x",
    "/relative",
    "https://user:pass@example.com/",
    "https://exa mple.com/",
    "",
    null,
  ]) {
    assert.equal(isSafeLinkUrl(url), false, String(url));
  }
});

test("Graphviz renders malicious DOT labels as inert escaped text", async () => {
  const { window, cleanup } = await makeDom();
  try {
    const view = makeView();
    // The handoff scope still reaches a DOT label verbatim, so it is the field
    // that must be proven inert (worker names are sanitized by the naming layer).
    view.delegation.handoffs[0].scope = '</text><script>alert("xss")</script><a href="javascript:alert(1)">x</a>';
    view.delegation.children[0].task = "onload=alert(1)";
    const dot = buildDot(projectGraph(view));
    const svg = await renderDot(dot);
    assert.ok(svg.includes("<svg"), "graphviz produced SVG");
    assert.ok(!/<script/i.test(svg), "raw script tag must not survive graphviz");
    const clean = sanitizeSvgMarkup(svg, window);
    assert.ok(clean.includes("<svg"));
    assert.ok(!/<script|onload\s*=|foreignObject|javascript:/i.test(clean));
    assert.ok(!/<a[\s>]/i.test(clean), "no anchor elements in generated graph");
    assert.ok(clean.includes("&lt;script&gt;") || clean.includes("&lt;/text&gt;"), "markup is rendered as text");
  } finally {
    cleanup();
  }
});

test("SVG sanitizer strips scripts, handlers, external resources and unsafe attributes", async () => {
  const { window, cleanup } = await makeDom();
  try {
    const marker = "http://attacker.invalid/track.js";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="alert(1)">
      <script>window.__pwned=1</script>
      <foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src="${marker}" onerror="alert(2)" /></body></foreignObject>
      <image href="${marker}" width="10" height="10"/>
      <a xlink:href="javascript:alert(3)"><text x="1" y="2">link</text></a>
      <rect id="keep-me" class="ok" x="1" y="1" width="4" height="4" fill="#fff" style="fill:url(${marker})" onmouseover="alert(4)"/>
      <style>@import "${marker}";</style>
    </svg>`;
    const clean = sanitizeSvgMarkup(svg, window);
    assert.ok(clean.includes("<svg"));
    assert.ok(clean.includes('id="keep-me"'));
    assert.ok(clean.includes('class="ok"'));
    assert.ok(clean.includes('viewBox="0 0 10 10"'), "safe SVG casing/attributes are preserved");
    for (const forbidden of ["<script", "foreignObject", "<image", "<a ", "javascript:", "onload", "onerror", "onmouseover", "style=", marker, "@import"]) {
      assert.ok(!clean.includes(forbidden), `sanitized SVG still contains ${forbidden}`);
    }
    assert.ok(clean.includes(">link<"), "anchor is unwrapped but its text is kept");
  } finally {
    cleanup();
  }
});

test("active markup is removed before it can reach any DOM", () => {
  const html = [
    '<p>safe</p>',
    '<img src=https://attacker.invalid/pixel.png onerror=alert(1) alt="tracker">',
    '<script>window.__pwned = 1</script>',
    '<iframe src="https://attacker.invalid/"></iframe>',
    '<svg onload=alert(2)><image href="https://attacker.invalid/x"/></svg>',
    '<video src="https://attacker.invalid/v.mp4"></video>',
    '<a href="javascript:alert(3)" onclick="alert(4)">link</a>',
  ].join("\n");
  const clean = stripActiveMarkup(html);
  for (const forbidden of ["<script", "<iframe", "<svg", "<image", "<video", "onerror", "onload", "onclick", "<img"]) {
    assert.ok(!clean.includes(forbidden), `pre-clean still contains ${forbidden}`);
  }
  assert.ok(clean.includes("<p>safe</p>"));
  assert.ok(clean.includes("[image blocked: tracker]"));
  assert.ok(clean.includes(">link</a>"), "link text is preserved for the later URL policy pass");
});

test("markdown rendering keeps tables/fences/links and neutralizes active content", async () => {
  const { window, DOMPurify, cleanup } = await makeDom();
  try {
    const { marked } = (await import("marked")) as Any;
    const markdown = [
      "# Title",
      "",
      "| name | value |",
      "| --- | --- |",
      "| a | 1 |",
      "",
      "```js",
      'const payload = "<script>alert(1)</script>";',
      "```",
      "",
      '<script>window.__pwned = 1</script>',
      '<img src="https://attacker.invalid/pixel.png" alt="tracking" onerror="alert(2)">',
      '<iframe src="https://attacker.invalid/"></iframe>',
      "",
      "[blocked](javascript:alert(3)) and [safe](https://example.com/doc) and [file](file:///etc/passwd)",
      "",
      "<a href=\"javascript:alert(4)\">raw link</a>",
    ].join("\n");
    const html = renderMarkdownSafe(markdown, { marked, DOMPurify, dom: window });
    assert.ok(html.includes("<table>"));
    assert.ok(html.includes("<th>name</th>"));
    assert.ok(html.includes('<code class="language-js">'), "fenced language class survives for highlighting");
    assert.ok(!/<script/i.test(html));
    assert.ok(!/<iframe/i.test(html));
    assert.ok(!/<img/i.test(html));
    assert.ok(!html.includes("javascript:"));
    assert.ok(!html.includes("file:///etc/passwd"));
    assert.ok(!html.includes("attacker.invalid/pixel.png"), "remote image URL is never emitted");
    assert.ok(html.includes("image blocked: tracking"));
    assert.ok(html.includes("md-link-blocked"));
    assert.ok(html.includes('href="https://example.com/doc"'));
    assert.ok(html.includes('rel="noopener noreferrer nofollow ugc"'));
    assert.ok(html.includes('target="_blank"'));
    assert.ok(html.includes("raw link"), "text of an unsafe link is preserved");
    assert.ok(!/\son\w+=/i.test(html), "no inline event handlers");
  } finally {
    cleanup();
  }
});

test("graph DOM decoration exposes accessible node semantics and selection", async () => {
  const { window, cleanup } = await makeDom();
  try {
    const view = makeView();
    const graph = projectGraph(view);
    const raw = await renderDot(buildDot(graph));
    const clean = sanitizeSvgMarkup(raw, window);
    const parsed = new window.DOMParser().parseFromString(clean, "image/svg+xml");
    const svg = window.document.importNode(parsed.documentElement, true);
    window.document.body.appendChild(svg);

    const elements = decorateGraphSvg(svg, graph, window.document);
    assert.ok(elements.size >= graph.nodes.length);
    const child = elements.get("child:c1") as Any;
    assert.ok(child, "worker node is decorated");
    assert.equal(child.getAttribute("data-node-id"), "child:c1");
    assert.equal(child.getAttribute("role"), "button");
    assert.equal(child.getAttribute("tabindex"), "0");
    assert.match(child.getAttribute("aria-label") || "", /Worker, Running\./);
    assert.match(child.getAttribute("data-node-kind") || "", /^child$/);
    assert.ok(child.classList.contains("kind-child"));
    assert.ok(child.querySelector("title")?.textContent?.includes("Running"));

    selectGraphNode(svg, "child:c1");
    assert.ok(child.classList.contains("is-selected"));
    assert.equal(child.getAttribute("aria-current"), "true");

    const statusChanged = makeView();
    statusChanged.delegation.children[0].status = "blocked";
    assert.equal(updateGraphSvg(svg, projectGraph(statusChanged)), true);
    assert.ok(child.classList.contains("status-blocked"));
    assert.ok(!child.classList.contains("status-running"));
    assert.match(child.getAttribute("aria-label") || "", /Blocked/);
    // Graphviz bakes the fill/stroke into the SVG and the stylesheet has no
    // `.graph-node.status-*` rule, so a status-only update must repaint. Without
    // it a finished child kept the green "Working" paint of its first snapshot.
    const painted = [...child.querySelectorAll("polygon,path,ellipse,rect")]
      .map(element => element.getAttribute("fill"));
    assert.ok(painted.includes("#31250f"), `status change must repaint the node: ${painted.join(", ")}`);
    assert.ok(!painted.includes("#10261d"), "the running fill must not survive the status change");

    assert.equal(graphNodeFromEvent(child.querySelector("text")), "child:c1");
    assert.equal(graphNodeFromEvent(svg), null);
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ state */

test("session list refresh never steals an existing selection", () => {
  let state = S.createState();
  state = S.applySessions(state, makeSessions());
  assert.equal(state.selectedSessionId, "s1", "initial selection prefers the live, most recent session");
  state = S.selectSession(state, "s-old");
  const newer = [...makeSessions(), {
    id: "s-new",
    name: "New",
    project: "p",
    mode: "normal",
    connected: true,
    lastSeen: 10_000,
    revision: 1,
    workers: { running: 3, total: 3 },
  }];
  const after = S.applySessions(state, newer);
  assert.equal(after.selectedSessionId, "s-old", "a new session must not steal selection");
  assert.deepEqual(after.sessions.map((session: Any) => session.id), ["s-new", "s1", "s-old"]);

  const withoutSelected = S.applySessions(after, newer.filter((session) => session.id !== "s-old"));
  assert.equal(withoutSelected.selectedSessionId, "s-new", "removal falls back deterministically");
  assert.equal(withoutSelected.session, null);
});

test("session changes clear artifact content immediately; stale responses are ignored", () => {
  let state = S.createState();
  state = S.applySessions(state, makeSessions());
  state = S.applySessionView(state, makeView(), S.sessionToken(state));
  assert.equal(state.session?.session.id, "s1");
  state = S.selectArtifact(state, "a-owned", 2);
  state = S.applyArtifact(state, { ...artifact("a-owned", "Owned artifact"), version: 2, content: "# body" }, S.artifactToken(state));
  assert.equal(state.artifact?.content, "# body");

  const oldSessionToken = S.sessionToken(state);
  const oldArtifactToken = S.artifactToken(state);
  const switched = S.selectSession(state, "s-old");
  assert.equal(switched.selectedArtifactId, null, "artifact selection is cleared on session change");
  assert.equal(switched.artifact, null, "artifact body is cleared on session change");
  assert.equal(switched.session, null, "old session view is cleared on session change");

  const staleView = S.applySessionView(switched, makeView(), oldSessionToken);
  assert.equal(staleView, switched, "a view for the previous session is rejected");
  const staleArtifact = S.applyArtifact(switched, { ...artifact("a-owned", "x"), version: 2, content: "stale" }, oldArtifactToken);
  assert.equal(staleArtifact, switched, "an artifact body for the previous session is rejected");

  const olderRevision = S.applySessionView(state, { ...makeView(), revision: 6 }, S.sessionToken(state));
  assert.equal(olderRevision, state, "older revisions never replace a newer view");
});

test("artifact version changes flag staleness and removals clear selection", () => {
  let state = S.createState();
  state = S.applySessions(state, makeSessions());
  state = S.applySessionView(state, makeView(), S.sessionToken(state));
  state = S.selectArtifact(state, "a-owned", 2);
  state = S.applyArtifact(state, { ...artifact("a-owned", "Owned artifact"), version: 2, content: "v2" }, S.artifactToken(state));

  const updatedView = makeView();
  updatedView.revision = 8;
  updatedView.artifacts[0] = artifact("a-owned", "Owned artifact", { scope: "api", childId: "c1", version: 3 });
  const updated = S.applySessionView(state, updatedView, S.sessionToken(state));
  assert.equal(updated.artifact, null, "stale body is cleared when the catalog advertises a new version");
  assert.equal(updated.artifactStale, true);
  assert.equal(updated.selectedArtifactId, "a-owned", "selection is retained for refresh");

  const removedView = makeView();
  removedView.revision = 9;
  removedView.artifacts = removedView.artifacts.filter((entry: Any) => entry.id !== "a-owned");
  const removed = S.applySessionView(updated, removedView, S.sessionToken(updated));
  assert.equal(removed.selectedArtifactId, null);
  assert.match(removed.notice || "", /removed/i);
});

test("artifact requests are epoch-guarded and version-checked", () => {
  let state = S.createState();
  state = S.applySessions(state, makeSessions());
  state = S.applySessionView(state, makeView(), S.sessionToken(state));

  state = S.selectArtifact(state, "a-owned", 2);
  const firstToken = S.artifactToken(state);
  state = S.selectArtifact(state, "a-done", 1);
  const secondToken = S.artifactToken(state);
  assert.notEqual(firstToken.epoch, secondToken.epoch);

  const lateFirst = S.applyArtifact(state, { ...artifact("a-owned", "late"), version: 2, content: "late" }, firstToken);
  assert.equal(lateFirst, state, "a response for the previous artifact selection is dropped");

  const wrongVersion = S.applyArtifact(state, { ...artifact("a-done", "Done"), version: 2, content: "v2" }, secondToken);
  assert.equal(wrongVersion, state, "a body whose version does not match the request is dropped");

  const applied = S.applyArtifact(state, { ...artifact("a-done", "Done"), version: 1, content: "v1" }, secondToken);
  assert.equal(applied.artifact?.content, "v1");

  const conflicted = S.applyArtifactError(state, new ApiError("Artifact changed", 409), secondToken);
  assert.equal(conflicted.artifact, null);
  assert.equal(conflicted.artifactStale, true);
  assert.equal(conflicted.artifactError?.status, 409);

  const staleError = S.applyArtifactError(applied, new ApiError("old", 500), firstToken);
  assert.equal(staleError, applied, "errors for an old epoch are ignored");
});

test("createState starts on the work tab in list mode with the drawer closed", () => {
  const state: Any = stateModel.createState();
  assert.equal(state.tab, "work");
  assert.equal(state.viewMode, "list");
  assert.equal(state.detailOpen, false);
  assert.equal(state.selectedNodeId, null);
});

test("openNodeDetail opens the drawer without changing the active tab", () => {
  let state: Any = stateModel.createState();
  state = stateModel.setTab(state, "artifacts");
  state = stateModel.setViewMode(state, "graph");
  const opened = stateModel.openNodeDetail(state, "handoff:h1");
  assert.equal(opened.selectedNodeId, "handoff:h1");
  assert.equal(opened.detailOpen, true);
  assert.equal(opened.tab, "artifacts", "clicking a node must never yank the user to another tab");
  assert.equal(opened.viewMode, "graph");
  assert.equal(stateModel.openNodeDetail(opened, "handoff:h1"), opened, "re-opening the same node is a no-op");
  const other = stateModel.openNodeDetail(opened, "child:c1");
  assert.equal(other.selectedNodeId, "child:c1");
  assert.equal(other.tab, "artifacts");
  assert.equal(state.selectedNodeId, null, "the previous state is not mutated");
});

test("selectArtifact opens the drawer; closeDetail clears node and artifact state", () => {
  let state: Any = stateModel.createState();
  state = stateModel.selectSession(state, "s1");
  state = S.applySessionView(state, makeView(), S.sessionToken(state));
  state = stateModel.openNodeDetail(state, "child:c1");
  state = S.selectArtifact(state, "a-owned", 2);
  assert.equal(state.detailOpen, true, "selecting an artifact opens the detail drawer");
  assert.equal(state.selectedArtifactId, "a-owned");
  state = S.applyArtifact(state, { ...artifact("a-owned", "Owned artifact"), version: 2, content: "v2" }, S.artifactToken(state));
  assert.equal(state.artifact?.content, "v2");

  const epoch = state.artifactEpoch;
  const tab = state.tab;
  const viewMode = state.viewMode;
  const closed = stateModel.closeDetail(state);
  assert.equal(closed.detailOpen, false);
  assert.equal(closed.selectedNodeId, null);
  assert.equal(closed.selectedArtifactId, null);
  assert.equal(closed.selectedArtifactVersion, null);
  assert.equal(closed.artifact, null, "the artifact body is dropped with the drawer");
  assert.equal(closed.artifactEpoch, epoch + 1, "in-flight artifact loads are invalidated");
  assert.equal(closed.tab, tab);
  assert.equal(closed.viewMode, viewMode);
  assert.equal(stateModel.closeDetail(closed), closed, "closing an already closed drawer is a no-op");

  const late = S.applyArtifact(closed, { ...artifact("a-owned", "Owned artifact"), version: 2, content: "late" }, S.artifactToken(state));
  assert.equal(late, closed, "a response for the closed artifact is rejected");
});

test("selectSession closes the detail and preserves tab and view mode", () => {
  let state: Any = stateModel.createState();
  state = stateModel.selectSession(state, "s1");
  state = stateModel.setTab(state, "artifacts");
  state = stateModel.setViewMode(state, "graph");
  state = stateModel.openNodeDetail(state, "child:c1");
  state = S.selectArtifact(state, "a-owned", 2);

  const switched: Any = S.selectSession(state, "s-old");
  assert.equal(switched.detailOpen, false, "switching sessions closes the drawer");
  assert.equal(switched.selectedNodeId, null);
  assert.equal(switched.selectedArtifactId, null);
  assert.equal(switched.tab, "artifacts", "the tab survives a session switch");
  assert.equal(switched.viewMode, "graph", "the view mode survives a session switch");
  assert.equal(switched.sessionEpoch, state.sessionEpoch + 1);
});

test("view mode transitions are pure", () => {
  const state: Any = stateModel.createState();
  const graphMode = stateModel.setViewMode(state, "graph");
  assert.equal(graphMode.viewMode, "graph");
  assert.equal(state.viewMode, "list", "the previous state is not mutated");
  assert.equal(graphMode.tab, "work");
  assert.equal(stateModel.setViewMode(graphMode, "graph"), graphMode, "an unchanged mode is the same object");
  assert.equal(stateModel.setViewMode(graphMode, "list").viewMode, "list");
});

/* -------------------------------------------------------------------- api */

test("API client encodes parameters and surfaces JSON errors", async () => {
  const calls: Array<{ url: string; init: Any }> = [];
  const api = createApi({
    fetchImpl: async (url: string, init: Any) => {
      calls.push({ url, init });
      if (url.startsWith("/api/sessions")) return { ok: true, status: 200, async json() { return { sessions: [] }; } };
      if (url.startsWith("/api/session")) return { ok: true, status: 200, async json() { return { session: { id: "a b&c" } }; } };
      return { ok: false, status: 409, async json() { return { error: "Artifact changed" }; } };
    },
  });
  assert.deepEqual(await api.sessions(), { sessions: [] });
  await api.session("a b&c");
  assert.equal(calls[1].url, "/api/session?id=a+b%26c");
  assert.equal(calls[1].init.credentials, "same-origin");
  await assert.rejects(
    () => api.artifact("s 1", "a/1", 3),
    (error: Any) => error instanceof ApiError && error.status === 409 && error.message === "Artifact changed",
  );
  assert.equal(calls[2].url, "/api/artifact?session=s+1&id=a%2F1&version=3");

  const badJson = createApi({ fetchImpl: async () => ({ ok: true, status: 200, async json() { throw new Error("bad"); } }) });
  await assert.rejects(() => badJson.sessions(), (error: Any) => error instanceof ApiError && /invalid JSON/.test(error.message));
});

test("change events are coalesced and parsed defensively", () => {
  let calls = 0;
  const scheduled: Array<(() => void) | null> = [];
  const coalescer = createChangeCoalescer(() => { calls += 1; }, {
    delay: 10,
    schedule: (fn: () => void) => {
      scheduled.push(fn);
      return scheduled.length;
    },
    clear: (handle: number) => {
      scheduled[handle - 1] = null;
    },
  });
  coalescer.trigger();
  coalescer.trigger();
  assert.equal(scheduled.length, 1, "bursts schedule exactly one refresh");
  assert.equal(calls, 0);
  scheduled[0]?.();
  assert.equal(calls, 1);

  coalescer.trigger();
  coalescer.cancel();
  scheduled[1]?.();
  assert.equal(calls, 1, "cancel drops a pending refresh");

  assert.equal(parseChangeEvent('{"type":"changed"}'), true);
  assert.equal(parseChangeEvent('{"type":"other"}'), false);
  assert.equal(parseChangeEvent("not json"), false);
  assert.equal(parseChangeEvent("null"), false);
});

/* --------------------------------------------------- kind encoding + motion */

test("DOT encodes node kind in shape and border, not only colour", () => {
  const graph = projectGraph(makeView());
  const dot = buildDot(graph);
  const lines = dot.split("\n");
  const nodeLine = (kind: string) => lines.find((line) => line.includes(`node-${kind}`)) || "";

  assert.match(nodeLine("session"), /shape="box3d"/);
  assert.match(nodeLine("child"), /shape="box".*style="rounded,filled"/);
  assert.match(nodeLine("handoff"), /shape="note"/, "a spec is a document, not a process");
  assert.match(nodeLine("handoff"), /style="dashed,filled"/, "dashed marks an authored artifact");
  assert.match(nodeLine("review"), /shape="hexagon"/);
  assert.match(nodeLine("spec-review"), /shape="folder"/);
  assert.match(nodeLine("escalation"), /shape="octagon"/);

  const handoffNode = graph.nodes.find((node: Any) => node.kind === "handoff")!;
  assert.match(handoffNode.label, /^Spec · /, "the handoff label says what it is");
  const workerNode = graph.nodes.find((node: Any) => node.kind === "child")!;
  assert.match(workerNode.label, /^[A-Za-z]+ · .+ Builder$/, "a worker is a person plus a role");
  assert.ok(workerNode.kindGlyph, "the drawer and list can draw the kind");

  const handoffEdge = lines.find((line) => line.includes("edge-handoff") && line.includes("->")) || "";
  assert.match(handoffEdge, /style="dotted"/);
  assert.match(handoffEdge, /arrowhead="normal"/);
  assert.match(handoffEdge, /tooltip="delivers"/);
  const escalationEdge = lines.find((line) => line.includes("edge-escalation") && line.includes("->")) || "";
  assert.match(escalationEdge, /style="dashed"/);
  assert.match(escalationEdge, /color="#c58a2b"/);

  // The graph frame carries its own caption, so no DOT title is emitted.
  assert.ok(!dot.includes('labelloc="t"'));
});

test("status-only updates keep kind classes, kind paint and no relayout", async () => {
  const { window, cleanup } = await makeDom();
  try {
    const view = makeView();
    const graph = projectGraph(view);
    const raw = await renderDot(buildDot(graph));
    const parsed = new window.DOMParser().parseFromString(sanitizeSvgMarkup(raw, window), "image/svg+xml");
    const svg = window.document.importNode(parsed.documentElement, true);
    window.document.body.appendChild(svg);
    decorateGraphSvg(svg, graph, window.document);

    const handoff = svg.querySelector('[data-node-id="handoff:h1"]') as Any;
    assert.equal(handoff.getAttribute("data-node-kind"), "handoff");
    assert.ok(handoff.classList.contains("kind-handoff"));
    assert.match(handoff.getAttribute("aria-label") || "", /Spec, (Running|Completed)/);

    const next = makeView();
    next.delegation.children[0].status = "completed";
    const nextGraph = projectGraph(next);
    assert.equal(topologySignature(graph), topologySignature(nextGraph), "a status change is not a topology change");
    assert.equal(updateGraphSvg(svg, nextGraph), true);
    assert.ok(handoff.classList.contains("kind-handoff"), "kind classes survive a status repaint");
    assert.ok(handoff.classList.contains("node-handoff"));
    assert.ok(!handoff.classList.contains("status-running"));

    // A handoff keeps its neutral paper paint when its status changes, so a spec
    // never reads as a running worker.
    const paper = [...handoff.querySelectorAll("path,polygon")].map((el: Any) => el.getAttribute("fill"));
    assert.ok(paper.includes("#1b2230"), `handoff paint is kind-driven: ${paper.join(", ")}`);
  } finally {
    cleanup();
  }
});

test("decorated graph introduces no inline styles, <style> or SMIL (CSP-safe)", async () => {
  const { window, cleanup } = await makeDom();
  try {
    const graph = projectGraph(makeView());
    const raw = await renderDot(buildDot(graph));
    const parsed = new window.DOMParser().parseFromString(sanitizeSvgMarkup(raw, window), "image/svg+xml");
    const svg = window.document.importNode(parsed.documentElement, true);
    decorateGraphSvg(svg, graph, window.document);
    assert.equal(svg.querySelectorAll("[style]").length, 0, "no inline style attributes");
    assert.equal(svg.querySelectorAll("style, animate, animateTransform, set").length, 0, "no stylesheet or SMIL inside the SVG");
    assert.equal(svg.querySelectorAll("[onclick],[onload],[onerror]").length, 0);
  } finally {
    cleanup();
  }
});

test("motion plan is class-based, status-flashes updates and dies under reduced motion", () => {
  const first: Any = projectGraph(makeView());
  first.signature = topologySignature(first);
  const firstPlan: Any = planGraphMotion(null, first, { reducedMotion: false });
  assert.equal(firstPlan.relayout, true);
  assert.ok(firstPlan.entering.length > 0, "first paint staggers the nodes in");
  assert.ok(firstPlan.entering.length <= MOTION.maxStagger);
  assert.deepEqual(firstPlan.updated, []);

  const statusOnly = makeView();
  statusOnly.delegation.children[0].status = "completed";
  const next: Any = projectGraph(statusOnly);
  next.signature = topologySignature(next);
  const inPlace: Any = planGraphMotion(first, next, { reducedMotion: false });
  assert.equal(inPlace.relayout, false, "a status change must not relayout");
  assert.deepEqual(inPlace.entering, []);
  assert.ok(inPlace.updated.includes("child:c1"), "the changed node flashes for 600ms");
  // A handoff derives its status from its workers, so it flashes with them; it
  // still never causes a relayout.
  assert.ok(inPlace.updated.includes("handoff:h1"));

  const topology = makeView();
  topology.delegation.children.push({ id: "c9", name: "new-worker", scope: "docs", status: "running", startedAt: 20 });
  const added: Any = projectGraph(topology);
  added.signature = topologySignature(added);
  const plan: Any = planGraphMotion(first, added, { reducedMotion: false });
  assert.equal(plan.relayout, true);
  assert.deepEqual(plan.entering, ["child:c9"]);
  assert.ok(plan.edgesToDraw.length >= 1, "a new spawn edge draws itself in");

  const reduced: Any = planGraphMotion(first, added, { reducedMotion: true });
  assert.equal(reduced.relayout, false);
  assert.deepEqual(reduced.entering, []);
  assert.deepEqual(reduced.edgesToDraw, []);
  assert.deepEqual(reduced.updated, []);
  assert.equal(reduced.reducedMotion, true);

  assert.equal(staggerDelayMs(0), 0);
  assert.ok(staggerDelayMs(50) < 400, "the stagger is capped so a burst stays snappy");
});

test("the projection names the root as the manager and never prints a uuid", () => {
  const uuid = "aa2e0e1c-1c2b-4d3e-8f90-0123456789ab";
  const view = makeView();
  view.session = { id: uuid, name: uuid, project: "pi-workflow-extensions", mode: "normal", branchId: "main" };
  const graph = projectGraph(view);
  const session = graph.nodes.find((node: Any) => node.kind === "session")!;
  assert.equal(session.label, "Pi Workflow Extensions Manager");
  assert.ok(!graph.nodes.some((node: Any) => String(node.label).includes(uuid)), "no uuid is rendered as a name");
  const labels = graph.nodes.map((node: Any) => node.label);
  assert.ok(labels.some((label: string) => label.startsWith('Spec · ')));
  assert.ok(labels.some((label: string) => label.endsWith("Manager")));
});
