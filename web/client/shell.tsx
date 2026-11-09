// Base shell: the three minimal pi regions (header, transcript, composer)
// with plugin slots around them, keyboard shortcuts, client-side routing
// to plugin pages (/plugins/:id), and region overrides — a plugin that
// declares { kind: "override", region } replaces the base region while its
// view is published, and the built-in region returns when it is not.

import { useEffect, useState } from "react";
import { usePiSession } from "./use-session.ts";
import { Transcript } from "./transcript.tsx";
import { Composer } from "./composer.tsx";
import { SlotHost } from "./plugins/slots.tsx";
import { PluginActionShortcuts } from "./plugins/PluginActionShortcuts.tsx";
import { PluginPage, parsePluginRoute } from "./plugins/PluginLayout.tsx";
import { PluginViewRenderer } from "./plugins/PluginViewRenderer.tsx";
import { resolveRegionOverrides, type RegionOverride } from "../shared/regions.ts";

function shortCwd(cwd: string): string {
  const parts = cwd.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? cwd;
}

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
      {regions.header !== undefined ? (
        <header className="app-header">
          <RegionOverrideView override={regions.header} region="header" />
        </header>
      ) : (
        <header className="app-header">
          <span className="app-title">pi</span>
          <span className="app-subtitle">minimal web client</span>
          <select
            className="app-session-select"
            value={session.selectedId ?? ""}
            onChange={(event) =>
              session.setSelectedId(event.target.value === "" ? null : event.target.value)}
            aria-label="Session"
          >
            <option value="">sessions…</option>
            {session.sessions.map((summary) => (
              <option key={summary.id} value={summary.id}>
                {shortCwd(summary.cwd)} · {summary.id.slice(0, 8)}
                {summary.live ? " ●" : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="app-new-session"
            onClick={() => {
              void session.newSession();
            }}
          >
            new
          </button>
          <span className="app-header-status">
            {regions.status !== undefined ? (
              <RegionOverrideView override={regions.status} region="status" />
            ) : (
              headerStatus
            )}
          </span>
        </header>
      )}
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
      {regions.composer !== undefined ? (
        <div className="app-composer app-composer-override">
          <RegionOverrideView override={regions.composer} region="composer" />
        </div>
      ) : (
        <Composer
          disabled={session.selectedId === null || session.connection !== "connected"}
          streaming={session.streaming.isStreaming}
          onSend={(text) => {
            void session.sendPrompt(text);
          }}
          onAbort={() => {
            void session.abort();
          }}
        />
      )}
      <SlotHost slot="bottom" plugins={session.plugins} views={session.pluginViews} />
      <SlotHost slot="floating" plugins={session.plugins} views={session.pluginViews} />
      <PluginActionShortcuts plugins={session.plugins} sessionId={session.selectedId} />
    </div>
  );
}
