import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./shell.tsx";
import { initTheme } from "./theme.ts";

// Before the first paint: the theme is on <html> before React renders.
initTheme();

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("pi-web-minimal: #root element missing from index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
);
