// Base shell: the three minimal pi regions (header, transcript, composer)
// with plugin slots around them, keyboard shortcuts, client-side routing
// to plugin pages (/plugins/:id), and region overrides — a plugin that
// declares { kind: "override", region } replaces the base region while its
// view is published, and the built-in region returns when it is not.

import { useEffect, useState } from "react";
import { usePiSession } from "./use-session.ts";
import { Transcript } from "./transcript.tsx";
import { Composer } from "./composer.tsx";
import { SessionSidebar } from "./sidebar.tsx";
import { NewSessionDialog } from "./new-session-dialog.tsx";
import { CustomPopups, EditorWidgets, StatusChips, ToastStack, UiPromptBanner } from "./popups.tsx";
import { SlotHost } from "./plugins/slots.tsx";
import { PluginActionShortcuts } from "./plugins/PluginActionShortcuts.tsx";
import { PluginPage, parsePluginRoute } from "./plugins/PluginLayout.tsx";
import { PluginViewRenderer } from "./plugins/PluginViewRenderer.tsx";
import { resolveRegionOverrides, type RegionOverride } from "../shared/regions.ts";

function useRoute(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  return path;
}

/** A base region replaced by a plugin's declarative view. */
function RegionOverrideView({
  override,
  region,
}: {
  override: RegionOverride;
  region: string;
}) {
  return (
    <div className={`app-region-override app-region-override-${region}`} data-region-override={region}>
      <PluginViewRenderer view={override.view} />
    </div>
  );
}

export function AppShell() {
  const session = usePiSession();
  const route = useRoute();
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  // Narrow screens: the sidebar starts collapsed and opens as an overlay.
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 720);

  // Crossing from wide to narrow closes the sidebar instead of leaving an
  // overlay + scrim stranded over the shrunken layout.
  useEffect(() => {
    let wasWide = window.innerWidth > 720;
    const onResize = (): void => {
      const wide = window.innerWidth > 720;
      if (wasWide && !wide) setSidebarOpen(false);
      wasWide = wide;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Plugin pages: /plugins/:id renders the descriptor's page surface with
  // its live view for the selected session and its actions.
  const pluginId = parsePluginRoute(route);
  if (pluginId !== null) {
    const plugin = session.plugins.find((p) => p.id === pluginId);
    if (plugin !== undefined) {
      return (
        <PluginPage
          plugin={plugin}
          view={session.pluginViews[plugin.id] ?? null}
          sessionId={session.selectedId}
          plugins={session.plugins}
        />
      );
    }
  }

  const headerStatus = session.connection === "connected"
    ? (session.sessionState?.model
      ? `${session.sessionState.model.provider}/${session.sessionState.model.id}`
      : "connected")
    : session.connection;
  const selected = session.sessions.find((summary) => summary.id === session.selectedId);
  const headerCwd = selected ? selected.cwd : "";

  // The transcript's working line shows while a reply streams or the session
  // reports itself running (ui.session.lifecycle); a hidden working model
  // never forces the line on.
  const showWorking =
    session.streaming.isStreaming
    || (session.uiRunning && (session.working?.visible ?? true));

  // Region overrides: header, status (inside the header), transcript and
  // composer. Resolved from the same per-session views the slots render.
  const { regions, conflicts } = resolveRegionOverrides(session.plugins, session.pluginViews);

  return (
    <div className="app-shell">
      <div className="app-body">
        {sidebarOpen ? <div className="app-sidebar-scrim" onClick={() => setSidebarOpen(false)} /> : null}
        <div className={sidebarOpen ? "app-sidebar-wrap is-open" : "app-sidebar-wrap"}>
          <SessionSidebar
            sessions={session.sessions}
            selectedId={session.selectedId}
            onSelect={(id) => {
              session.setSelectedId(id);
              if (window.innerWidth <= 720) setSidebarOpen(false);
            }}
            selectedRunning={session.streaming.isStreaming || session.uiRunning}
            onNewSession={() => setNewSessionOpen(true)}
          />
        </div>
        <div className="app-main">
          {regions.header !== undefined ? (
            <header className="app-header">
              <RegionOverrideView override={regions.header} region="header" />
            </header>
          ) : (
            <header className="app-header">
              <button
                type="button"
                className="app-sidebar-toggle"
                aria-label="Toggle session list"
                title="Sessions"
                onClick={() => setSidebarOpen((open) => !open)}
              >
                ☰
              </button>
              {headerCwd !== "" ? <span className="app-subtitle">{headerCwd}</span> : null}
              <StatusChips statuses={session.statuses} />
              <span className="app-header-status">
                {regions.status !== undefined ? (
                  <RegionOverrideView override={regions.status} region="status" />
                ) : (
                  headerStatus
                )}
              </span>
            </header>
          )}
          <UiPromptBanner prompt={session.uiPrompt} />
          {conflicts.length > 0 ? (
            <div className="app-region-conflicts" role="status">
              {conflicts.map((conflict) => (
                <span key={conflict.region} className="app-region-conflict">
                  {conflict.region} override: {conflict.pluginIds.join(", ")} — last registered wins
                </span>
              ))}
            </div>
          ) : null}
          <SlotHost slot="top" plugins={session.plugins} views={session.pluginViews} />
          {regions.transcript !== undefined ? (
            <main className="app-transcript" aria-live="polite">
              <RegionOverrideView override={regions.transcript} region="transcript" />
            </main>
          ) : (
            <Transcript
              history={session.history}
              userMessages={session.userMessages}
              streaming={session.streaming}
              toolStatus={session.toolStatus}
              toolResults={session.toolResults}
              working={session.working}
              showWorking={showWorking}
            />
          )}
          <SlotHost slot="center" plugins={session.plugins} views={session.pluginViews} />
          <EditorWidgets widgets={session.widgets} placement="aboveEditor" />
          {regions.composer !== undefined ? (
            <div className="app-composer app-composer-override">
              <RegionOverrideView override={regions.composer} region="composer" />
            </div>
          ) : (
            <Composer
              disabled={session.selectedId === null || session.connection !== "connected"}
              busy={session.streaming.isStreaming || session.uiRunning}
              error={session.sendError}
              sessionCommands={session.sessionCommands}
              builtinCommands={session.builtinCommands}
              onSend={(text, images) => {
                void session.sendPrompt(text, images);
              }}
              onAbort={() => {
                void session.abort();
              }}
            />
          )}
          <EditorWidgets widgets={session.widgets} placement="belowEditor" />
          <SlotHost slot="bottom" plugins={session.plugins} views={session.pluginViews} />
        </div>
      </div>
      <SlotHost slot="floating" plugins={session.plugins} views={session.pluginViews} />
      <CustomPopups custom={session.custom} />
      <ToastStack notifications={session.notifications} />
      <PluginActionShortcuts plugins={session.plugins} sessionId={session.selectedId} />
      <NewSessionDialog
        open={newSessionOpen}
        sessions={session.sessions}
        onClose={() => setNewSessionOpen(false)}
        onStart={(cwd) => session.newSession(cwd)}
      />
    </div>
  );
}
