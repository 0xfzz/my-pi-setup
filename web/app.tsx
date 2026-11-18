// Client composition root: starts the core shell and the browser-half runtime.
// Plugins register their own panels and pages from manifest-discovered bundles;
// this file lives OUTSIDE web/core so the core client never imports a plugin.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "./core/client/auth-gate.tsx";
import { getAuth } from "./core/client/auth.ts";
import { AppShell } from "./core/client/shell.tsx";
import { RequestLoading } from "./core/client/request-loading.tsx";
import { initTheme } from "./core/client/theme.ts";
import { installBrowserLogging } from "./core/client/logging.ts";
import { pluginProtocolClient } from "./core/client/protocol-client.ts";
import { mountPluginBrowserHalves } from "./plugins/browser-halves.ts";

// Before the first paint: the theme is on <html> before React renders.
initTheme();
// Capture native fetch and console before auth wraps either one. Browser
// warnings and crashes then reach the server log without a retry loop.
installBrowserLogging();
// Wraps window.fetch so a request that finds the access token expired refreshes the
// session and retries, before any component issues its first request.
getAuth();

// The composition root never calls a plugin's mount directly: the runtime
// checks trust, safe mode, lifecycle, hash-bound grants and point rules, then
// drives loadBrowserHalf/mountBrowserHalf with a built-in restoring host.
mountPluginBrowserHalves(document.body, {
  protocol: pluginProtocolClient,
  host: {},
  theme: {},
  logger: { info: () => undefined, warn: (message) => console.warn(message) },
  dom: {
    text: (value) => document.createTextNode(value),
    clear: (element) => { element.replaceChildren(); },
  },
});

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("pi-web-minimal: #root element missing from index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <RequestLoading />
    <AuthGate>
      <AppShell />
    </AuthGate>
  </StrictMode>,
);