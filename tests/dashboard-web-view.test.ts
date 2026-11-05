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
import { validateRegistry } from "../lib/web-plugins/registry.ts";
import { WEB_PLUGINS } from "../web-plugins/index.ts";
import { WEB_PLUGIN_VIEW_EVENT } from "../lib/web-plugins/view.ts";
import { DASHBOARD_STATE_EVENT } from "../lib/dashboard/protocol.ts";
import dashboardExtension from "../extensions/dashboard.ts";

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

test("web-plugins registry: WEB_PLUGINS contains id 'dashboard' and passes validateRegistry", () => {
  const dashboard = WEB_PLUGINS.find((p) => p.id === "dashboard");
  assert.ok(dashboard, "WEB_PLUGINS must contain id 'dashboard'");
  assert.equal(dashboard.extension, "dashboard");

  const errors = validateRegistry(WEB_PLUGINS);
  assert.deepEqual(errors, [], `Registry validation failed: ${errors.join(", ")}`);
});

function createMockDashboardHarness(sessionId: string) {
  const eventHandlers = new Map<string, (data: unknown) => void>();
  const emittedViews: any[] = [];
  const notifications: string[] = [];
  let sessionStartListener: ((event: unknown, ctx: unknown) => void) | undefined;

  const mockPi: any = {
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        eventHandlers.set(channel, handler);
        return () => eventHandlers.delete(channel);
      },
      emit(channel: string, data: unknown) {
        if (channel === WEB_PLUGIN_VIEW_EVENT) {
          emittedViews.push(data);
        }
      },
    },
    registerTool: () => {},
    registerCommand: () => {},
    on(eventName: string, handler: any) {
      if (eventName === "session_start") sessionStartListener = handler;
    },
    setSessionName: () => {},
    appendEntry: () => {},
  };

  const mockContext: any = {
    sessionManager: {
      getBranch: () => [],
      getHeader: () => ({ id: sessionId }),
      getSessionId: () => sessionId,
    },
    ui: {
      notify(msg: string) {
        notifications.push(msg);
      },
    },
  };

  return {
    mockPi,
    mockContext,
    eventHandlers,
    emittedViews,
    notifications,
    startSession() {
      sessionStartListener?.({}, mockContext);
    },
  };
}

test("dashboardExtension: by default standalone server does not start, but web view publishes on first delegated child", async () => {
  const originalEnv = process.env.PI_DASHBOARD_SERVER;
  delete process.env.PI_DASHBOARD_SERVER;

  try {
    const harness = createMockDashboardHarness("parent-sess-default");
    dashboardExtension(harness.mockPi, { coalesceMs: 0 });
    harness.startSession();

    const onState = harness.eventHandlers.get(DASHBOARD_STATE_EVENT);
    assert.ok(onState, "Must listen for DASHBOARD_STATE_EVENT");

    onState({
      delegation: {
        children: [
          {
            id: "child-default-1",
            name: "Default Worker",
            scope: "core",
            status: "running",
            laneFiles: [],
            lastMilestoneFiles: [],
          },
        ],
        handoffs: [],
        reviews: [],
        escalations: [],
        specReviews: [],
        paused: false,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(harness.emittedViews.length > 0, "Web view must be published on first delegated child");
    const dashView = harness.emittedViews.find((v) => v.pluginId === "dashboard");
    assert.ok(dashView, "Must publish dashboard plugin view");
    assert.equal(dashView.view.rows.some((r: any) => r.label === "child · Default Worker"), true);

    assert.equal(
      harness.notifications.some((n) => n.startsWith("Dashboard:")),
      false,
      "No standalone server notification should be sent by default",
    );
  } finally {
    if (originalEnv !== undefined) {
      process.env.PI_DASHBOARD_SERVER = originalEnv;
    } else {
      delete process.env.PI_DASHBOARD_SERVER;
    }
  }
});

test("dashboardExtension: server opt-in (options.server=true or PI_DASHBOARD_SERVER=1) starts server producer AND publishes web view", async () => {
  const harness = createMockDashboardHarness("parent-sess-opt-in");
  let serverProducerStarted = false;
  let serverSnapshotPublished: any = null;

  const spyProducerFactory = async (producerOpts: any) => {
    serverProducerStarted = true;
    producerOpts.onReady?.("http://127.0.0.1:9177");
    return {
      publish(snapshot: any) {
        serverSnapshotPublished = snapshot;
      },
      close() {},
    };
  };

  dashboardExtension(harness.mockPi, {
    server: true,
    producerFactory: spyProducerFactory,
    coalesceMs: 0,
  });

  harness.startSession();
  const onState = harness.eventHandlers.get(DASHBOARD_STATE_EVENT);
  assert.ok(onState);

  onState({
    delegation: {
      children: [
        {
          id: "child-optin-1",
          name: "Optin Worker",
          scope: "core",
          status: "running",
          laneFiles: [],
          lastMilestoneFiles: [],
        },
      ],
      handoffs: [],
      reviews: [],
      escalations: [],
      specReviews: [],
      paused: false,
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(serverProducerStarted, true, "Server producer factory must be called when server opt-in is enabled");
  assert.ok(serverSnapshotPublished, "Server producer must receive snapshot");
  assert.ok(harness.emittedViews.length > 0, "Web view must also be published");
  assert.equal(
    harness.notifications.includes("Dashboard: http://127.0.0.1:9177"),
    true,
    "onReady notification must be delivered to UI",
  );
});

test("dashboardExtension: server: false suppresses server producer even if producerFactory is provided", async () => {
  const harness = createMockDashboardHarness("parent-sess-off");
  let serverProducerStarted = false;

  const spyProducerFactory = async () => {
    serverProducerStarted = true;
    return {
      publish: () => {},
      close: () => {},
    };
  };

  dashboardExtension(harness.mockPi, {
    server: false,
    producerFactory: spyProducerFactory,
    coalesceMs: 0,
  });

  harness.startSession();
  const onState = harness.eventHandlers.get(DASHBOARD_STATE_EVENT);
  assert.ok(onState);

  onState({
    delegation: {
      children: [
        {
          id: "child-off-1",
          name: "Off Worker",
          scope: "core",
          status: "running",
          laneFiles: [],
          lastMilestoneFiles: [],
        },
      ],
      handoffs: [],
      reviews: [],
      escalations: [],
      specReviews: [],
      paused: false,
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(serverProducerStarted, false, "Server producer must not start when server: false");
  assert.ok(harness.emittedViews.length > 0, "Web view must still be published");
});

test("dashboardExtension: PI_DASHBOARD_SERVER=1 activates server mode via environment variable", async () => {
  const originalEnv = process.env.PI_DASHBOARD_SERVER;
  process.env.PI_DASHBOARD_SERVER = "1";

  try {
    const harness = createMockDashboardHarness("parent-sess-env-optin");
    let serverProducerStarted = false;

    const spyProducerFactory = async () => {
      serverProducerStarted = true;
      return {
        publish: () => {},
        close: () => {},
      };
    };

    dashboardExtension(harness.mockPi, {
      producerFactory: spyProducerFactory,
      coalesceMs: 0,
    });

    harness.startSession();
    const onState = harness.eventHandlers.get(DASHBOARD_STATE_EVENT);
    assert.ok(onState);

    onState({
      delegation: {
        children: [
          {
            id: "child-env-1",
            name: "Env Worker",
            scope: "core",
            status: "running",
            laneFiles: [],
            lastMilestoneFiles: [],
          },
        ],
        handoffs: [],
        reviews: [],
        escalations: [],
        specReviews: [],
        paused: false,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(serverProducerStarted, true, "PI_DASHBOARD_SERVER=1 must activate server mode");
    assert.ok(harness.emittedViews.length > 0, "Web view must still be published");
  } finally {
    if (originalEnv !== undefined) {
      process.env.PI_DASHBOARD_SERVER = originalEnv;
    } else {
      delete process.env.PI_DASHBOARD_SERVER;
    }
  }
});
