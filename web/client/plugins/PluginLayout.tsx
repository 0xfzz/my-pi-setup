// Plugin page: /plugins/:id renders the descriptor's title and description,
// its live view for the selected session, its actions, and links to every
// other page plugin.

import type { WebPluginDescriptor, WebView } from "./contract.ts";
import { ArrowLeft } from "@phosphor-icons/react";
import { PluginViewRenderer } from "./PluginViewRenderer.tsx";
import { PluginActions } from "./PluginActions.tsx";

export interface PluginPageProps {
  plugin: WebPluginDescriptor;
  view: WebView | null;
  sessionId: string | null;
  plugins: readonly WebPluginDescriptor[];
}

function pageHref(plugin: WebPluginDescriptor): string {
  const surface = plugin.surfaces.find((s) => s.kind === "page");
  return surface && "path" in surface ? (surface.path as string) : `/plugins/${plugin.id}`;
}

export function PluginPage({ plugin, view, sessionId, plugins }: PluginPageProps) {
  const pagePlugins = plugins.filter((p) => p.surfaces.some((surface) => surface.kind === "page"));

  return (
    <div className="app-shell">
      <header className="app-header">
        <a href="/" className="plugin-nav-home-link" title="Back to pi web">
          <ArrowLeft size={13} /> pi web
        </a>
        <span className="app-title">{plugin.title}</span>
        {plugin.description ? <span className="app-subtitle">{plugin.description}</span> : null}
      </header>
      <main className="app-transcript">
        <div className="plugin-page">
          <PluginViewRenderer view={view} />
          <PluginActions pluginId={plugin.id} sessionId={sessionId} actions={plugin.actions} />
        </div>
      </main>
      {pagePlugins.length > 1 ? (
        <nav className="plugin-page-nav" aria-label="Plugin navigation">
          {pagePlugins.map((p) => (
            <a
              key={p.id}
              href={pageHref(p)}
              className={`plugin-nav-link${p.id === plugin.id ? " active" : ""}`}
              aria-current={p.id === plugin.id ? "page" : undefined}
            >
              {p.title}
            </a>
          ))}
        </nav>
      ) : null}
    </div>
  );
}

/** Route helper: does the pathname address a plugin page, and which id? */
export function parsePluginRoute(pathname: string): string | null {
  const match = /^\/plugins\/([a-z0-9][a-z0-9-]*)$/.exec(pathname);
  return match ? match[1] : null;
}
