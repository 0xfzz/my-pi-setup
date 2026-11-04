"use client";

import React, { useEffect, useState } from "react";

export interface WebPluginSurface {
  kind: "sidebar" | "page";
  path?: string;
}

export interface WebPluginDescriptor {
  id: string;
  extension: string;
  title: string;
  description?: string;
  surfaces: readonly WebPluginSurface[];
}

interface PluginNavProps {
  plugins?: readonly WebPluginDescriptor[];
  currentPluginId?: string;
  variant?: "toolbar" | "header" | "list";
}

export function PluginNav({ plugins: initialPlugins, currentPluginId, variant = "toolbar" }: PluginNavProps) {
  const [plugins, setPlugins] = useState<readonly WebPluginDescriptor[]>(initialPlugins ?? []);

  useEffect(() => {
    if (initialPlugins && initialPlugins.length > 0) {
      setPlugins(initialPlugins);
      return;
    }
    let mounted = true;
    void fetch("/api/plugins")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { plugins?: WebPluginDescriptor[] } | null) => {
        if (mounted && data?.plugins) {
          setPlugins(data.plugins);
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [initialPlugins]);

  const pagePlugins = plugins.filter((p) =>
    p.surfaces.some((s) => s.kind === "page"),
  );

  if (pagePlugins.length === 0) return null;

  if (variant === "header") {
    return (
      <nav className="plugin-header-nav" aria-label="Plugin navigation">
        <a href="/" className="plugin-nav-home-link" title="Back to main chat">
          ← Pi Web
        </a>
        <div className="plugin-nav-items">
          {pagePlugins.map((plugin) => {
            const pageSurface = plugin.surfaces.find((s) => s.kind === "page");
            const href = (pageSurface && "path" in pageSurface ? pageSurface.path : `/plugins/${plugin.id}`) as string;
            const active = plugin.id === currentPluginId;
            return (
              <a
                key={plugin.id}
                href={href}
                className={`plugin-nav-link ${active ? "active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                {plugin.title}
              </a>
            );
          })}
        </div>
      </nav>
    );
  }

  // "toolbar" variant for the sidebar bottom bar in AppShell
  return (
    <div className="plugin-toolbar-nav" role="group" aria-label="Plugins">
      {pagePlugins.map((plugin) => {
        const pageSurface = plugin.surfaces.find((s) => s.kind === "page");
        const href = (pageSurface && "path" in pageSurface ? pageSurface.path : `/plugins/${plugin.id}`) as string;
        return (
          <a
            key={plugin.id}
            href={href}
            className="plugin-toolbar-link"
            title={plugin.description ?? plugin.title}
            aria-label={plugin.title}
          >
            <span className="plugin-toolbar-title">{plugin.title}</span>
          </a>
        );
      })}
    </div>
  );
}
