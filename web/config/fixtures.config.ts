/**
 * E2E fixture registration. Session factories live in the fixture plugin;
 * the ids, environment names and view surfaces live here.
 */
export const WEB_TEST_FIXTURES = Object.freeze({
  activationEnv: "PI_WEB_TEST_PLUGIN_VIEWS",
  filesRootEnv: "PI_WEB_TEST_FILES_ROOT",
  sessionId: "__test_session__",
  sessionTitle: "Plan review",
  fallbackActionPlugin: "subagent-graph",
  defaultActionFactory: "monitorGraph",
  actionFactories: Object.freeze<Record<string, string>>({
    router: "routingGraph",
    "subagent-graph": "monitorGraph",
  }),
  views: Object.freeze([
    { pluginId: "cache-stats", factory: "cacheStats" },
    { pluginId: "todo", factory: "todo" },
    { pluginId: "artifacts", factory: "artifacts" },
    { pluginId: "subagent-checkpoints", factory: "checkpoints" },
    { pluginId: "subagent-graph", factory: "monitorGraph" },
    { pluginId: "router", factory: "routingGraph" },
    { pluginId: "example-override", factory: "override" },
  ]),
});
