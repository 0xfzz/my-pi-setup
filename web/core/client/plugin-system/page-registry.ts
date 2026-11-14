// Client-side custom page registry — the page-surface twin of the panel
// registry. A plugin whose page (/plugins/:id) is a bespoke tool (MCP
// manager) rather than the generic session-view renderer registers its
// component here from its own module; PluginLayout reads the registry and
// never imports a plugin directly. The dependency stays one-way: plugins
// depend on core, core does not depend on plugins.

import type { ComponentType } from "react";
import type { WebPluginDescriptor } from "../../plugin-contracts/descriptor.ts";

/** The props the core shell passes to every custom page. */
export interface HostPageProps {
  plugin: WebPluginDescriptor;
  sessionId: string | null;
  plugins: readonly WebPluginDescriptor[];
}

export type HostPageComponent = ComponentType<HostPageProps>;

const pages = new Map<string, HostPageComponent>();

/** Register a bespoke page; called from the plugin's own module at import time. */
export function registerPluginPage(id: string, component: HostPageComponent): void {
  pages.set(id, component);
}

/** The registered component for `id`, or undefined when the plugin has none. */
export function getPluginPage(id: string): HostPageComponent | undefined {
  return pages.get(id);
}
