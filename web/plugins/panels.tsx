// Client-side custom panel registration for the first-party plugins. A plugin
// that renders a bespoke right side panel (Files, Artifacts) rather than the
// generic declarative view registers its component here at import time. The
// core shell reads the registry; it never imports this module. Adding a custom
// panel is one line.

import { registerPluginPanel, type HostPanelProps } from "../core/client/plugin-system/panel-registry.tsx";
import { ArtifactsPanel } from "./artifacts/ArtifactsPanel.tsx";
import { FilesPanel } from "./files/FilesPanel.tsx";

function filesPanel({ open, onClose, sessionId, rootLabel }: HostPanelProps) {
  return (
    <FilesPanel
      open={open}
      onClose={onClose}
      sessionId={sessionId}
      rootLabel={rootLabel}
    />
  );
}

function artifactsPanel({ open, onClose, view }: HostPanelProps) {
  return <ArtifactsPanel open={open} onClose={onClose} view={view} />;
}

registerPluginPanel("files", filesPanel);
registerPluginPanel("artifacts", artifactsPanel);