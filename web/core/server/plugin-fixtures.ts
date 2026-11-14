// Test fixtures and resets for the plugin surfaces.
//
// Nothing here runs at import: a caller decides. The Playwright suites start
// the server with PI_WEB_TEST_PLUGIN_VIEWS=1 and main() seeds the fixture
// session explicitly, so production code carries no import-time side effect and
// no test reads an environment variable on the host's behalf.

import { WEB_PLUGIN_ACTION_REQUEST_EVENT } from "../plugin-contracts/actions.ts";
import { recordPluginView, pluginView } from "./plugin-views.ts";
import { clearPluginSessionState, registerSessionBusForTests, releaseInFlightActions, sessionBus, type MinimalEventBus } from "./plugin-sessions.ts";
import { recordWorkingUi, webUiStore } from "./ui-store.ts";

/** The session id every fixture view hangs off. */
export const FIXTURE_SESSION_ID = "__test_session__";

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

/**
 * A bus that answers an action request by republishing the monitor graph, so the
 * e2e can prove an action reaches the extension and comes back as a new view.
 * A handled action also releases the in-flight lock: a follow-up action must not
 * be refused for the rest of the TTL.
 */
function fixtureBus(): MinimalEventBus {
  return {
    on: () => () => {},
    emit: (channel: string, data: unknown) => {
      if (channel !== WEB_PLUGIN_ACTION_REQUEST_EVENT) return;
      const request = data as { requestId?: string };
      recordPluginView(FIXTURE_SESSION_ID, "subagent-monitor", monitorFixtureGraph(request?.requestId || "synced"));
      releaseInFlightActions(FIXTURE_SESSION_ID);
    },
  };
}

interface FixtureView {
  pluginId: string;
  view: unknown;
}

/** One seed per plugin surface the e2e drives. */
const FIXTURE_VIEWS: readonly FixtureView[] = [
  {
    pluginId: "cache-stats",
    view: {
      type: "kv",
      title: "Cache health test",
      rows: [
        // The e2e asserts this is rendered as text, never as markup.
        { label: "XSS Test", value: "<script>alert('xss')</script>" },
        { label: "Hit rate", value: "94.2%" },
      ],
    },
  },
  {
    pluginId: "todo",
    view: {
      type: "list",
      title: "Active tasks",
      items: [
        { text: "Implement frontend slots", status: "done", detail: "**Status:** done\n**Evidence:**\n- file `web/core/client/plugin-system/slots.tsx`" },
        { text: "Verify e2e test suite", status: "active", detail: "**Status:** claimed\n**Claim:** worker · 12 min left" },
        { text: "A much longer task title that will wrap onto a second line in the narrow sidebar panel", status: "pending", detail: "**Status:** open" },
      ],
    },
  },
  { pluginId: "artifacts", view: { type: "list", title: "Artifacts", items: ["prd-phase-6.md", "slot-architecture.png"] } },
  {
    pluginId: "subagent-checkpoints",
    view: {
      type: "kv",
      title: "Delegated work",
      rows: [
        { label: "Active child", value: "worker-slots" },
        { label: "Status", value: "In progress" },
      ],
    },
  },
  { pluginId: "subagent-monitor", view: monitorFixtureGraph("seeded") },
  // The reference override plugin: proves the composer region renders a plugin
  // view instead of the built-in input.
  { pluginId: "example-override", view: { type: "status", tone: "accent", text: "Composer replaced (fixture)" } },
];

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
 * primitives the Playwright suites assert on. Idempotent: a view that already
 * exists is left alone.
 */
export function seedPluginFixtures(): void {
  const sessionId = FIXTURE_SESSION_ID;
  if (sessionBus(sessionId) === undefined) registerSessionBusForTests(sessionId, fixtureBus());
  for (const { pluginId, view } of FIXTURE_VIEWS) {
    if (pluginView(sessionId, pluginId) === undefined) recordPluginView(sessionId, pluginId, view);
  }
  seedUiPrimitives(sessionId);
}

/**
 * Reset every plugin surface between tests: the unified store (which holds the
 * views), the per-session bridge, and the fixture bookkeeping.
 */
export function clearWebPluginStateForTests(): void {
  webUiStore.clear();
  clearPluginSessionState();
  seededWorkingSessions.clear();
}
