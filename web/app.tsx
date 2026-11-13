// Client composition root: wires the core shell to the first-party plugin
// panel registrations before the first render. This file lives OUTSIDE
// web/core so the core client never imports a plugin — panels self-register
// into the core plugin-system registry (see web/plugins/panels.tsx).

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "./core/client/auth-gate.tsx";
import { getAuth } from "./core/client/auth.ts";
import { AppShell } from "./core/client/shell.tsx";
import { initTheme } from "./core/client/theme.ts";
// Side-effect import: registers the Files and Artifacts bespoke panels.
import "./plugins/panels.tsx";

// Before the first paint: the theme is on <html> before React renders.
initTheme();
// Wraps window.fetch so a request that finds the access token expired refreshes the
// session and retries, before any component issues its first request.
getAuth();

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("pi-web-minimal: #root element missing from index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <AuthGate>
      <AppShell />
    </AuthGate>
  </StrictMode>,
);