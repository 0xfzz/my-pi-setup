import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "./auth-gate.tsx";
import { getAuth } from "./auth.ts";
import { AppShell } from "./shell.tsx";
import { initTheme } from "./theme.ts";

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
