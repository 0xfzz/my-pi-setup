/**
 * E2E plugin-fixture registrations. The ids and surface mapping live in the
 * single web registry; the factories stay in this fixture plugin so core owns
 * no plugin data.
 */
import { WEB_TEST_FIXTURES } from "../../../registry.config.ts";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT } from "../../../core/plugin-contracts/actions.ts";
import { recordPluginView, pluginView } from "../../../core/server/plugin-views.ts";
import { clearActionState, releaseInFlightActions } from "../../../core/server/plugin-actions.ts";
import {
  clearPluginSessionState,
  registerSessionBusForTests,
  sessionBus,
  type MinimalEventBus,
} from "../../../core/server/plugin-sessions.ts";
import { recordWorkingUi, webUiStore } from "../../../core/server/ui-store.ts";

export const FIXTURE_SESSION_ID = WEB_TEST_FIXTURES.sessionId;

const seededWorkingSessions = new Set<string>();

/** Seeded delegated-work graph for the subagent monitor. */
function monitorFixtureGraph(lastRequest: string): unknown {
  return {
    type: "graph",
    title: "Delegated work graph",
    nodes: [
      { id: "parent", label: "Fixture parent", kind: "parent", status: "active" },
      {
        id: "child:worker-slots",
        label: `worker-slots · ${lastRequest}`,
        kind: "child",
        status: "active",
        detail: `**Task:** Port slot adapters\n**Last request:** ${lastRequest}`,
      },
    ],
    edges: [{ from: "parent", to: "child:worker-slots", label: "handoff" }],
  };
}

/** Routing canvas fixture: reload changes the selected branch through the real view bus. */
function routingFixtureGraph(selected: number): unknown {
  return {
    type: "graph", title: "Routing",
    nodes: [
      { id: "route", label: "router/balanced", kind: "parent", status: "done", detail: "**round-robin · on turn**\n\nRoutes requests across the configured model chain." },
      ...["primary/deepseek-v4.1-flash", "secondary/deepseek-v4.1-flash", "backup/gemini-pro"].map((label, index) => ({
        id: `target:${index}`, label, kind: "child", status: index === selected ? "active" : "neutral",
        detail: index === selected ? "Selected by the latest routing decision. Prompt cache warm." : "Standby candidate. No routing change is made when inspecting this node.",
      })),
      { id: "issue:0", label: "Rotating every turn may rewrite the prompt cache.", kind: "review", status: "blocked" },
    ],
    edges: [0, 1, 2].map(index => ({ from: "route", to: `target:${index}`, label: `${index + 1}` })),
  };
}

const viewFactories: Readonly<Record<string, () => unknown>> = Object.freeze({
  cacheStats: () => ({
    type: "kv",
    title: "Cache health test",
    rows: [
      // The e2e asserts this is rendered as text, never as markup.
      { label: "XSS Test", value: "<script>alert('xss')</script>" },
      { label: "Hit rate", value: "94.2%" },
    ],
  }),
  todo: () => ({
    type: "list",
    title: "Active tasks",
    items: [
      { text: "Implement frontend slots", status: "done", detail: "**Status:** done\n**Evidence:**\n- file `web/core/client/plugin-system/slots.tsx`" },
      { text: "Verify e2e test suite", status: "active", detail: "**Status:** claimed\n**Claim:** worker · 12 min left" },
      { text: "A much longer task title that will wrap onto a second line in the narrow sidebar panel", status: "pending", detail: "**Status:** open" },
    ],
  }),
  artifacts: () => ({ type: "list", title: "Artifacts", items: ["prd-phase-6.md", "slot-architecture.png"] }),
  checkpoints: () => ({
    type: "kv",
    title: "Delegated work",
    rows: [
      { label: "Active child", value: "worker-slots" },
      { label: "Status", value: "In progress" },
    ],
  }),
  monitorGraph: () => monitorFixtureGraph("seeded"),
  routingGraph: () => routingFixtureGraph(0),
  override: () => ({ type: "status", tone: "accent", text: "Composer replaced (fixture)" }),
});

const actionFactories: Readonly<Record<string, (requestId: string) => unknown>> = Object.freeze({
  monitorGraph: (requestId) => monitorFixtureGraph(requestId || "synced"),
  routingGraph: () => routingFixtureGraph(1),
});

/**
 * A bus that answers an action request by republishing the registered graph,
 * so the e2e can prove an action reaches the extension and comes back as a new
 * view. A handled action also releases the in-flight lock.
 */
function fixtureBus(): MinimalEventBus {
  return {
    on: () => () => {},
    emit: (channel: string, data: unknown) => {
      if (channel !== WEB_PLUGIN_ACTION_REQUEST_EVENT) return;
      const request = data as { requestId?: string; pluginId?: string };
      const pluginId = request.pluginId ?? WEB_TEST_FIXTURES.fallbackActionPlugin;
      const name = WEB_TEST_FIXTURES.actionFactories[pluginId] ?? WEB_TEST_FIXTURES.defaultActionFactory;
      const factory = actionFactories[name];
      if (factory === undefined) return;
      recordPluginView(FIXTURE_SESSION_ID, pluginId, factory(request.requestId ?? ""));
      releaseInFlightActions(FIXTURE_SESSION_ID);
    },
  };
}

/** The UI primitives the e2e checks, driven through the same store as production. */
function seedUiPrimitives(sessionId: string): void {
  if (seededWorkingSessions.has(sessionId)) return;
  recordWorkingUi(sessionId, { message: "Ratiocinating..." });
  webUiStore.publish(sessionId, "ui.notify", { message: "Fixture toast: sync complete", level: "info" });
  webUiStore.publish(sessionId, "ui.status.changed", { key: "fixture-status", text: "fixture ready" });
  webUiStore.publish(sessionId, "ui.widget.changed", {
    key: "fixture-widget",
    lines: ["fixture widget line"],
    placement: "aboveEditor",
  });
  seededWorkingSessions.add(sessionId);
}

/**
 * Seed the fixture session with the views, the working model and the UI
 * primitives the Playwright suites assert on. Idempotent: an existing view is
 * left alone.
 */
export function seedPluginFixtures(): void {
  if (sessionBus(FIXTURE_SESSION_ID) === undefined) {
    registerSessionBusForTests(FIXTURE_SESSION_ID, fixtureBus());
  }
  for (const { pluginId, factory: name } of WEB_TEST_FIXTURES.views) {
    const factory = viewFactories[name];
    if (factory === undefined) throw new Error(`unknown web fixture factory: ${name}`);
    if (pluginView(FIXTURE_SESSION_ID, pluginId) === undefined) {
      recordPluginView(FIXTURE_SESSION_ID, pluginId, factory());
    }
  }
  seedUiPrimitives(FIXTURE_SESSION_ID);
}

/**
 * Reset every plugin surface between tests: the unified store, the per-session
 * bridge, and the fixture bookkeeping.
 */
export function clearWebPluginStateForTests(): void {
  webUiStore.clear();
  clearPluginSessionState();
  clearActionState();
  seededWorkingSessions.clear();
}
