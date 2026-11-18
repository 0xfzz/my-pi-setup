// Client composition root: wires the core shell to the first-party plugin
// panel registrations before the first render. This file lives OUTSIDE
// web/core so the core client never imports a plugin — panels self-register
// into the core plugin-system registry from their own browser halves.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "./core/client/auth-gate.tsx";
import { getAuth } from "./core/client/auth.ts";
import { AppShell } from "./core/client/shell.tsx";
import { RequestLoading } from "./core/client/request-loading.tsx";
import { initTheme } from "./core/client/theme.ts";
import { installBrowserLogging } from "./core/client/logging.ts";
// Plugin-owned browser halves register their own panels; core only provides
// the registry and context (web/core has no plugin-specific import).
import { ProtocolClient } from "./core/client/protocol-client.ts";
import { mountPluginBrowserHalves } from "./plugins/browser-halves.ts";
// Side-effect import: registers the MCP manager bespoke page.
import "./plugins/pages.tsx";

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
  protocol: new ProtocolClient({ sessionId: "browser" }),
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