// Session sidebar: the session list with live/running/stopped indicators,
// replacing the header dropdown. One row per session — the project name,
// the state dot (pulsing while a turn runs), and how long ago it was active.

import type { SessionSummary } from "./use-session.ts";

function shortCwd(cwd: string): string {
  const parts = cwd.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? cwd;
}

/** "just now" / "5m" / "3h" / "2d" — coarse is enough for a session list. */
function relativeTime(modifiedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - modifiedAt) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export interface SessionSidebarProps {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onNewSession: () => void;
  /** The selected session is mid-turn right now (known instantly from the stream). */
  selectedRunning?: boolean;
}

export function SessionSidebar({
  sessions,
  selectedId,
  onSelect,
  onNewSession,
  selectedRunning,
}: SessionSidebarProps) {
  const now = Date.now();
  const ordered = [...sessions].sort((a, b) => {
    // Live sessions first, then most recently active.
    if (a.live !== b.live) return a.live ? -1 : 1;
    return b.modifiedAt - a.modifiedAt;
  });

  return (
    <nav className="app-sidebar" aria-label="Sessions">
      <div className="app-sidebar-head">
        <span className="app-title">pi</span>
        <span className="app-subtitle">web</span>
      </div>
      <button
        type="button"
        className="app-sidebar-new"
        onClick={onNewSession}
        title="Start a new session (pick a project directory)"
      >
        + new session
      </button>
      <div className="app-sidebar-list" role="listbox" aria-label="Sessions">
        {ordered.length === 0 ? (
          <div className="app-sidebar-empty">No sessions yet.</div>
        ) : null}
        {ordered.map((session) => {
          const selected = session.id === selectedId;
          const running = session.running === true || (selected && selectedRunning === true);
          const state = running
            ? "running"
            : session.live
              ? "live"
              : "stopped";
          return (
            <button
              key={session.id}
              type="button"
              role="option"
              aria-selected={selected}
              data-id={session.id}
              className={`app-session-item${selected ? " is-selected" : ""}`}
              data-state={state}
              onClick={() => onSelect(session.id)}
              title={`${session.cwd}\n${session.id}${state === "running" ? " — running" : state === "live" ? " — attached" : ""}`}
            >
              <span className={`app-session-dot app-session-dot-${state}`} aria-hidden="true" />
              <span className="app-session-body">
                <span className="app-session-name">{shortCwd(session.cwd)}</span>
                <span className="app-session-meta">
                  {session.id.slice(0, 8)} · {relativeTime(session.modifiedAt, now)}
                </span>
              </span>
              {state === "running" ? <span className="app-session-running">run</span> : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
