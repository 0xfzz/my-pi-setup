// Server composition root: wires the plugin registry into the core HTTP host
// before serving. This file lives OUTSIDE web/core so the core server never
// imports a plugin — the built-in descriptor list is registered here, then
// the core server starts. Run directly (tsx server.ts) or via /web start.

import { WEB_PLUGINS } from "./plugins/index.ts";
import { registerWebPlugins } from "./core/server/plugin-host.ts";
import { main } from "./core/server/main.ts";

// Importing web/core/server/main.ts sets PI_WEB_SERVER_PROCESS=1, so the
// in-process session resume path does not bridge a web-resumed session back
// to the server that owns it. Register the descriptors before serving; the
// /api/plugins route and action gate read from this registry.
registerWebPlugins(WEB_PLUGINS);

void main();