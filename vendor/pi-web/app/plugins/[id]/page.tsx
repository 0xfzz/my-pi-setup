"use client";

import { use } from "react";
import { useSearchParams } from "next/navigation";
import {
  PluginViewRenderer,
  SessionStatusDot,
  usePluginData,
} from "@/components/plugins/PluginViewRenderer";
import { PluginNav } from "@/components/plugins/PluginNav";
import { PluginActions } from "@/components/plugins/PluginActions";
import type { WebView } from "@/lib/web-plugins-host";
import "@/components/plugins/plugins.css";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function PluginPage({ params }: PageProps) {
  const resolvedParams = use(params);
  const pluginId = resolvedParams.id;
  const searchParams = useSearchParams();
  const sessionParam = searchParams.get("session");

  const { plugins, views, sessions, loading } = usePluginData();
  const currentPlugin = plugins.find((p) => p.id === pluginId) ?? null;

  // Find view and active session for this plugin
  let foundView: WebView | null = null;
  let activeSession: string | null = sessionParam;
  if (views) {
    if (sessionParam) {
      foundView = views[sessionParam]?.[pluginId] ?? null;
    } else {
      // Pick latest published across sessions
      for (const sessId of Object.keys(views)) {
        if (views[sessId]?.[pluginId]) {
          foundView = views[sessId][pluginId];
          activeSession = sessId;
        }
      }
      if (!activeSession && Object.keys(views).length > 0) {
        activeSession = Object.keys(views)[0];
      }
    }
  }

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

  const sessionInfo = activeSession ? sessions?.[activeSession] : undefined;

  return (
    <div className="plugin-page-container">
      <header className="plugin-page-header">
        <PluginNav plugins={plugins} currentPluginId={pluginId} variant="header" />
      </header>
      <main className="plugin-page-main">
        <div className="plugin-heading-area">
          <div className="plugin-title-row">
            <h1 className="plugin-page-title">{currentPlugin.title}</h1>
            {activeSession && (
              <div className="plugin-session-status" data-testid="plugin-session-status">
                <SessionStatusDot
                  running={sessionInfo?.running}
                  awaitingInput={sessionInfo?.awaitingInput}
                  sessionId={activeSession}
                  showLabel
                />
                <span className="plugin-session-name">{activeSession}</span>
              </div>
            )}
          </div>
          {currentPlugin.description && (
            <p className="plugin-page-description">{currentPlugin.description}</p>
          )}
        </div>
        {currentPlugin.actions && currentPlugin.actions.length > 0 && (
          <PluginActions
            pluginId={currentPlugin.id}
            sessionId={activeSession}
            actions={currentPlugin.actions}
          />
        )}
        <div className="plugin-view-card">
          <PluginViewRenderer view={foundView} />
        </div>
      </main>
    </div>
  );
}
