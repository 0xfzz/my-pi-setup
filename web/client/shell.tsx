// Base shell: the three minimal pi regions (header, transcript, composer)
// wired to the session hook. Plugin slots and override surfaces land in
// later phases around these regions.

import { usePiSession } from "./use-session.ts";
import { Transcript } from "./transcript.tsx";
import { Composer } from "./composer.tsx";

function shortCwd(cwd: string): string {
  const parts = cwd.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? cwd;
}

export function AppShell() {
  const session = usePiSession();

  const headerStatus = session.connection === "connected"
    ? (session.sessionState?.model
      ? `${session.sessionState.model.provider}/${session.sessionState.model.id}`
      : "connected")
    : session.connection;

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-title">pi</span>
        <span className="app-subtitle">minimal web client</span>
        <select
          className="app-session-select"
          value={session.selectedId ?? ""}
          onChange={(event) => session.setSelectedId(event.target.value === "" ? null : event.target.value)}
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
      <main className="app-transcript" aria-live="polite">
        <Transcript
          history={session.history}
          userMessages={session.userMessages}
          streaming={session.streaming}
          toolStatus={session.toolStatus}
        />
      </main>
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
    </div>
  );
}
