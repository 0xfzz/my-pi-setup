// Server composition root: wires the plugin registry into the core HTTP host
// before serving. This file lives OUTSIDE web/core so the core server never
// imports a plugin — the built-in descriptor list is registered here, then
// the core server starts. Run directly (tsx server.ts) or via /web start.

import { WEB_PLUGINS, WEB_TEST_FIXTURES } from "./registry.config.ts";
import { registerWebPlugins } from "./core/server/plugin-host.ts";
import { watchPluginRegistry } from "./core/server/plugin-registry-broadcast.ts";
import { announcePluginsChanged } from "./core/server/sessions.ts";
import { main } from "./core/server/main.ts";
import { seedPluginFixtures } from "./plugins/fixture-e2e/server/fixtures.ts";
import { registerFixtureSession } from "./plugins/fixture-e2e/server/fixture-session.ts";

// Importing web/core/server/main.ts sets PI_WEB_SERVER_PROCESS=1, so the
// in-process session resume path does not bridge a web-resumed session back
// to the server that owns it. Register the descriptors before serving; the
// /api/plugins route and action gate read from this registry.
const host = registerWebPlugins(WEB_PLUGINS);

// Every lifecycle move that changes what is served is pushed to open browsers,
// so a tab never keeps a plugin set the server no longer serves. Wired here,
// not in the kernel: the kernel knows the audit log, this file knows the
// session directory that carries the frame.
watchPluginRegistry(host, announcePluginsChanged);

void main({
  onStarted: () => {
    if (process.env[WEB_TEST_FIXTURES.activationEnv] !== "1") return;
    seedPluginFixtures();
    registerFixtureSession();
  },
});
