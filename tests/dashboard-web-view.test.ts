import test from "node:test";
import assert from "node:assert/strict";

import { snapshotToWebView } from "../lib/dashboard/web-view.ts";
import {
  emptyDelegation,
  type DashboardArtifact,
  type DashboardChild,
  type DashboardEscalation,
  type DashboardHandoff,
  type DashboardReview,
  type DashboardSessionInfo,
  type DashboardSpecReview,
} from "../lib/dashboard/protocol.ts";
import { projectSnapshot } from "../lib/dashboard/projection.ts";
import { validateView, type KvWebView } from "../lib/web-plugins/view.ts";

function findRow(view: KvWebView, label: string) {
  return view.rows.find((r) => r.label === label);
}

test("dashboard-web-view: (a) fixture snapshot with children, handoffs, reviews, escalation, spec review, artifacts", () => {
  const session: DashboardSessionInfo = {
    id: "session-parity-1",
    name: "Data Parity Session",
    project: "pi-workflow-extensions",
    mode: "normal",
  };

  const children: DashboardChild[] = [
    {
      id: "child-alpha",
      name: "Alpha Worker",
      scope: "auth",
      status: "running",
      task: "Implement OAuth flow",
      laneFiles: ["lib/auth.ts"],
      lastMilestoneFiles: [],
    },
    {
      id: "child-beta",
      name: "Beta Worker",
      scope: "billing",
      status: "completed",
      task: "Add Stripe webhooks",
      laneFiles: ["lib/billing.ts"],
      lastMilestoneFiles: [],
    },
    {
      id: "child-gamma",
      name: "Gamma Worker",
      scope: "docs",
      status: "failed",
      task: "Write setup guide",
      laneFiles: ["docs/setup.md"],
      lastMilestoneFiles: [],
    },
  ];

  const handoffs: DashboardHandoff[] = [
    {
      id: "handoff-auth",
      scope: "auth",
      goal: "Implement OAuth2 PKCE login",
      acceptanceCriteria: ["Token refresh works"],
    },
    {
      id: "handoff-billing",
      scope: "billing",
      goal: "Support recurring subscriptions",
      acceptanceCriteria: ["Invoices generated"],
    },
  ];

  const reviews: DashboardReview[] = [
    {
      id: "review-auth",
      scope: "auth",
      verdict: "accepted",
      summary: "Clean implementation and tests pass",
    },
    {
      id: "review-billing",
      scope: "billing",
      verdict: "changes-requested",
      summary: "Missing idempotency key test",
    },
  ];

  const escalations: DashboardEscalation[] = [
    {
      id: "esc-1",
      childId: "child-alpha",
      scope: "auth",
      question: "Should we support Google and GitHub auth?",
      stage: "blocked",
    },
  ];

  const specReviews: DashboardSpecReview[] = [
    {
      id: "sr-1",
      title: "Auth Security Spec",
      status: "approved",
      reviewerIds: ["reviewer-1"],
    },
  ];

  const artifacts: DashboardArtifact[] = [
    {
      id: "art-auth-spec",
      title: "Authentication Architecture",
      type: "spec",
      version: 1,
      content: "SUPER_SECRET_PAYLOAD_SPEC_AUTH",
      createdBy: "lead",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      tags: ["architecture", "auth"],
    },
    {
      id: "art-billing-plan",
      title: "Billing Migration Plan",
      type: "plan",
      version: 2,
      content: "SUPER_SECRET_PAYLOAD_PLAN_BILLING",
      createdBy: "lead",
      createdAt: "2026-11-02T00:00:00.000Z",
      updatedAt: "2026-11-02T00:00:00.000Z",
      tags: ["stripe", "billing"],
    },
    {
      id: "art-setup-scratch",
      title: "Setup Scratchpad",
      type: "scratchpad",
      version: 1,
      content: "SUPER_SECRET_PAYLOAD_SCRATCH_SETUP",
      createdBy: "lead",
      createdAt: "2026-11-03T00:00:00.000Z",
      updatedAt: "2026-11-03T00:00:00.000Z",
      tags: [],
    },
  ];

  const snapshot = projectSnapshot({
    session,
    delegation: {
      children,
      handoffs,
      reviews,
      escalations,
      specReviews,
      paused: false,
    },
    artifacts,
  });

  const view = snapshotToWebView(snapshot) as KvWebView;
  assert.equal(view.type, "kv");
  assert.equal(view.title, "Data Parity Session");

  // Counts rows are first and match array lengths
  assert.equal(view.rows[0]?.label, "children");
  assert.equal(view.rows[0]?.value, "3");
  assert.equal(view.rows[1]?.label, "handoffs");
  assert.equal(view.rows[1]?.value, "2");
  assert.equal(view.rows[2]?.label, "reviews");
  assert.equal(view.rows[2]?.value, "2");
  assert.equal(view.rows[3]?.label, "artifacts");
  assert.equal(view.rows[3]?.value, "3");

  // General metadata rows
  assert.equal(findRow(view, "session")?.value, "session-parity-1");
  assert.equal(findRow(view, "mode")?.value, "normal");
  assert.equal(findRow(view, "paused")?.value, "false");

  const rowDump = JSON.stringify(view.rows);

  // Every child id, name, and status appears
  for (const child of children) {
    assert.ok(rowDump.includes(child.id), `Child id "${child.id}" missing from rows`);
    assert.ok(rowDump.includes(child.name), `Child name "${child.name}" missing from rows`);
    assert.ok(rowDump.includes(child.status), `Child status "${child.status}" missing from rows`);
  }

  // Every handoff goal appears
  for (const handoff of handoffs) {
    assert.ok(rowDump.includes(handoff.goal), `Handoff goal "${handoff.goal}" missing from rows`);
    assert.ok(rowDump.includes(handoff.id), `Handoff id "${handoff.id}" missing from rows`);
  }

  // Every review verdict appears
  for (const review of reviews) {
    assert.ok(rowDump.includes(review.verdict), `Review verdict "${review.verdict}" missing from rows`);
    assert.ok(rowDump.includes(review.summary), `Review summary "${review.summary}" missing from rows`);
  }

  // Escalation question and stage
  for (const esc of escalations) {
    assert.ok(rowDump.includes(esc.question), `Escalation question "${esc.question}" missing from rows`);
    assert.ok(rowDump.includes(esc.stage), `Escalation stage "${esc.stage}" missing from rows`);
  }

  // Spec review title and status
  for (const sr of specReviews) {
    assert.ok(rowDump.includes(sr.title), `Spec review title "${sr.title}" missing from rows`);
    assert.ok(rowDump.includes(sr.status), `Spec review status "${sr.status}" missing from rows`);
  }

  // Every artifact title appears
  for (const art of artifacts) {
    assert.ok(rowDump.includes(art.title), `Artifact title "${art.title}" missing from rows`);
    assert.ok(rowDump.includes(art.id), `Artifact id "${art.id}" missing from rows`);
  }

  // Passes validateView
  const validated = validateView(view);
  assert.equal(validated.ok, true);
});

test("dashboard-web-view: (b) artifact content never appears in JSON.stringify(view)", () => {
  const secretContent = "HIGHLY_CONFIDENTIAL_SECRET_TOKEN_DO_NOT_LEAK";
  const snapshot = projectSnapshot({
    session: { id: "s-leak-test", name: "Leak Test", project: "test", mode: "normal" },
    delegation: emptyDelegation(),
    artifacts: [
      {
        id: "art-classified",
        title: "Classified Doc",
        type: "spec",
        version: 1,
        content: secretContent,
        createdBy: "author",
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        tags: ["classified"],
      },
    ],
  });

  const view = snapshotToWebView(snapshot);
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes(secretContent), false, "Artifact content leaked into view!");
});

test("dashboard-web-view: (c) empty snapshot yields a view validateView accepts", () => {
  const snapshot = projectSnapshot({
    session: { id: "s-empty", name: "", project: "test", mode: "normal" },
    delegation: emptyDelegation(),
    artifacts: [],
  });

  const view = snapshotToWebView(snapshot);
  assert.equal(view.type, "kv");
  const validated = validateView(view);
  assert.equal(validated.ok, true);
  if (validated.ok) {
    assert.equal(validated.view.type, "kv");
    const kv = validated.view as KvWebView;
    assert.equal(findRow(kv, "children")?.value, "0");
    assert.equal(findRow(kv, "handoffs")?.value, "0");
    assert.equal(findRow(kv, "reviews")?.value, "0");
    assert.equal(findRow(kv, "artifacts")?.value, "0");
    assert.equal(findRow(kv, "paused")?.value, "false");
  }
});

test("dashboard-web-view: (d) snapshot with 300 children yields a view that passes validateView, has omitted>0, and stays under 64 KB", () => {
  const manyChildren: DashboardChild[] = [];
  for (let i = 0; i < 300; i++) {
    manyChildren.push({
      id: `child-${i}`,
      name: `Worker Task ${i} with long descriptive name for capacity test`,
      scope: `scope-${i % 10}`,
      status: i % 2 === 0 ? "running" : "completed",
      task: `Execute substantial subagent assignment number ${i} with detailed instructions and criteria`,
      laneFiles: [`src/module-${i % 20}.ts`],
      lastMilestoneFiles: [],
    });
  }

  const snapshot = projectSnapshot({
    session: { id: "s-300", name: "Stress 300 Children", project: "test", mode: "normal" },
    delegation: {
      children: manyChildren,
      handoffs: [],
      reviews: [],
      escalations: [],
      specReviews: [],
      paused: false,
    },
    artifacts: [],
  });

  const view = snapshotToWebView(snapshot) as KvWebView;
  assert.equal(view.type, "kv");

  // omitted > 0 reported
  assert.ok(typeof view.omitted === "number" && view.omitted > 0, `Expected omitted > 0, got ${view.omitted}`);

  // rows capped at max 200
  assert.ok(view.rows.length <= 200, `Expected rows <= 200, got ${view.rows.length}`);

  // serialized size under 64 KB
  const byteSize = Buffer.byteLength(JSON.stringify(view), "utf8");
  assert.ok(byteSize < 65536, `Expected size < 65536 bytes, got ${byteSize}`);

  // passes validateView
  const validated = validateView(view);
  assert.equal(validated.ok, true);
});

test("dashboard-web-view: (e) child named '<script>alert(1)</script>' appears verbatim as text", () => {
  const xssName = "<script>alert(1)</script>";
  const child: DashboardChild = {
    id: "child-xss",
    name: xssName,
    scope: "security",
    status: "running",
    laneFiles: [],
    lastMilestoneFiles: [],
  };

  const snapshot = projectSnapshot({
    session: { id: "s-xss", name: "XSS Session", project: "test", mode: "normal" },
    delegation: {
      children: [child],
      handoffs: [],
      reviews: [],
      escalations: [],
      specReviews: [],
      paused: false,
    },
    artifacts: [],
  });

  const view = snapshotToWebView(snapshot) as KvWebView;
  assert.equal(view.type, "kv");

  const row = view.rows.find((r) => r.label === `child · ${xssName}`);
  assert.ok(row, "Row with XSS script name label must exist");
  assert.equal(row.label, `child · ${xssName}`);

  const serialized = JSON.stringify(view);
  assert.ok(serialized.includes(xssName), "Script tag must be preserved verbatim in JSON text");

  const validated = validateView(view);
  assert.equal(validated.ok, true);
});

test("dashboard-web-view: (f) views always pass validateView({ok: true})", () => {
  const snapshots = [
    projectSnapshot({
      session: { id: "s1", name: "S1", project: "p", mode: "normal" },
      delegation: emptyDelegation(),
      artifacts: [],
    }),
    projectSnapshot({
      session: { id: "s2", name: "", project: "p", mode: "plan" },
      delegation: {
        children: [
          {
            id: "c-alone",
            name: "lone-worker",
            scope: "core",
            status: "closed",
            laneFiles: [],
            lastMilestoneFiles: [],
          },
        ],
        handoffs: [],
        reviews: [],
        escalations: [],
        specReviews: [],
        paused: true,
      },
      artifacts: [],
    }),
  ];

  for (const snap of snapshots) {
    const view = snapshotToWebView(snap);
    const result = validateView(view);
    assert.equal(result.ok, true);
  }
});
