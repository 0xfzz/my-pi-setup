// Client-side custom panel registry. A plugin that renders a bespoke right
// side panel (Files, Artifacts) rather than the generic declarative view
// registers its component here from its own module; the core shell reads the
// registry and never imports a plugin directly. Keeping the registry in the
// plugin-system means the dependency stays one-way: plugins depend on core,
// core does not depend on plugins.

import type { ComponentType } from "react";
import type { WebView } from "./contract.ts";

/** The props the core shell passes to every custom panel. */
export interface HostPanelProps {
  open: boolean;
  onClose: () => void;
  sessionId: string | null;
  rootLabel: string;
  view: WebView | null | undefined;
}

export type HostPanelComponent = ComponentType<HostPanelProps>;

const panels = new Map<string, HostPanelComponent>();

/** Register a bespoke panel; called from the plugin's own module at import time. */
export function registerPluginPanel(id: string, component: HostPanelComponent): void {
  panels.set(id, component);
}

/** The registered component for `id`, or undefined when the plugin has none. */
export function getPluginPanel(id: string): HostPanelComponent | undefined {
  return panels.get(id);
}