// Client-side custom panel registry. A plugin that renders a bespoke right
// side panel (Files, Artifacts) rather than the generic declarative view
// registers its component here. Adding a custom panel is one line; the core
// shell never imports a plugin directly.

import type { ComponentType } from "react";
import type { WebView } from "../core/client/plugin-system/contract.ts";
import { ArtifactsPanel } from "./artifacts/ArtifactsPanel.tsx";
import { FilesPanel } from "./files/FilesPanel.tsx";

/** The props the core shell passes to every custom panel. */
export interface HostPanelProps {
  open: boolean;
  onClose: () => void;
  sessionId: string | null;
  rootLabel: string;
  view: WebView | null | undefined;
}

export type HostPanelComponent = ComponentType<HostPanelProps>;

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

export const PLUGIN_PANELS: Record<string, HostPanelComponent> = {
  files: filesPanel,
  artifacts: artifactsPanel,
};

export function hasPluginPanel(id: string | null): boolean {
  return id !== null && id in PLUGIN_PANELS;
}