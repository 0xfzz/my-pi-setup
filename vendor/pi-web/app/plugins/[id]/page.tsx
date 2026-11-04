"use client";

import { useEffect, useState, use } from "react";
import { useSearchParams } from "next/navigation";
import { PluginViewRenderer } from "@/components/plugins/PluginViewRenderer";
import { PluginNav } from "@/components/plugins/PluginNav";
import type { WebPluginDescriptor, WebView } from "@/lib/web-plugins-host";
import "@/components/plugins/plugins.css";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function PluginPage({ params }: PageProps) {
  const resolvedParams = use(params);
  const pluginId = resolvedParams.id;
  const searchParams = useSearchParams();
  const sessionParam = searchParams.get("session");

  const [loading, setLoading] = useState(true);
  const [plugins, setPlugins] = useState<readonly WebPluginDescriptor[]>([]);
  const [currentPlugin, setCurrentPlugin] = useState<WebPluginDescriptor | null>(null);
  const [view, setView] = useState<WebView | null>(null);

  useEffect(() => {
    let mounted = true;

    async function loadPluginData() {
      try {
        const res = await fetch("/api/plugins", { cache: "no-store" });
        if (!res.ok) {
          if (mounted) setLoading(false);
          return;
        }
        const data = await res.json() as {
          plugins?: WebPluginDescriptor[];
          views?: Record<string, Record<string, WebView>>;
        };

        if (!mounted) return;

        const allPlugins = data.plugins ?? [];
        setPlugins(allPlugins);

        const target = allPlugins.find((p) => p.id === pluginId) ?? null;
        setCurrentPlugin(target);

        // Find view for this plugin
        let foundView: WebView | null = null;
        if (data.views) {
          if (sessionParam) {
            foundView = data.views[sessionParam]?.[pluginId] ?? null;
          } else {
            // Pick latest published across sessions
            for (const sessId of Object.keys(data.views)) {
              if (data.views[sessId]?.[pluginId]) {
                foundView = data.views[sessId][pluginId];
              }
            }
          }
        }
        setView(foundView);
      } catch (err) {
        console.error("Failed to load plugin data:", err);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    void loadPluginData();
    const interval = setInterval(() => {
      void loadPluginData();
    }, 3000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [pluginId, sessionParam]);

  if (loading && !currentPlugin) {
    return (
      <div className="plugin-page-container">
        <header className="plugin-page-header">
          <a href="/" className="plugin-nav-home-link">← Pi Web</a>
        </header>
        <main className="plugin-page-main">
          <p>Loading plugin...</p>
        </main>
      </div>
    );
  }

  if (!currentPlugin) {
    return (
      <div className="plugin-page-container">
        <header className="plugin-page-header">
          <a href="/" className="plugin-nav-home-link">← Pi Web</a>
        </header>
        <main className="plugin-page-main">
          <h1 className="plugin-page-title">Plugin not found</h1>
          <p className="plugin-page-description">No registered plugin matching &ldquo;{pluginId}&rdquo;</p>
        </main>
      </div>
    );
  }

  return (
    <div className="plugin-page-container">
      <header className="plugin-page-header">
        <PluginNav plugins={plugins} currentPluginId={pluginId} variant="header" />
      </header>
      <main className="plugin-page-main">
        <div className="plugin-heading-area">
          <h1 className="plugin-page-title">{currentPlugin.title}</h1>
          {currentPlugin.description && (
            <p className="plugin-page-description">{currentPlugin.description}</p>
          )}
        </div>
        <div className="plugin-view-card">
          <PluginViewRenderer view={view} />
        </div>
      </main>
    </div>
  );
}
