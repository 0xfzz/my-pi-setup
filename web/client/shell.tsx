// Base shell: the three minimal pi regions (header, transcript, composer)
// with plugin slots around them, keyboard shortcuts, and client-side
// routing to plugin pages (/plugins/:id).

import { useEffect, useState } from "react";
import { usePiSession } from "./use-session.ts";
import { Transcript } from "./transcript.tsx";
import { Composer } from "./composer.tsx";
import { SlotHost } from "./plugins/slots.tsx";
import { PluginActionShortcuts } from "./plugins/PluginActionShortcuts.tsx";
import { PluginPage, parsePluginRoute } from "./plugins/PluginLayout.tsx";

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

  return (
    <div className="app-shell">
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
        <span className="app-header-status">{headerStatus}</span>
      </header>
      <SlotHost slot="top" plugins={session.plugins} views={session.pluginViews} />
      <main className="app-transcript" aria-live="polite">
        <Transcript
          history={session.history}
          userMessages={session.userMessages}
          streaming={session.streaming}
          toolStatus={session.toolStatus}
          working={session.working}
          showWorking={showWorking}
        />
      </main>
      <SlotHost slot="center" plugins={session.plugins} views={session.pluginViews} />
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
      <SlotHost slot="bottom" plugins={session.plugins} views={session.pluginViews} />
      <SlotHost slot="floating" plugins={session.plugins} views={session.pluginViews} />
      <PluginActionShortcuts plugins={session.plugins} sessionId={session.selectedId} />
    </div>
  );
}
