// Session sidebar: the session list with live/running/stopped indicators,
// replacing the header dropdown. One row per session — the project name,
// the state dot (pulsing while a turn runs), and how long ago it was active.

import { useState } from "react";
import { MagnifyingGlass, Moon, Plus, Sun, Terminal } from "@phosphor-icons/react";
import type { SessionSummary } from "./use-session.ts";
import { useAuth } from "./auth-gate.tsx";
import { toggleTheme, type Theme } from "./theme.ts";

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
  // The theme is on <html> before first paint; the glyph only mirrors it.
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  const auth = useAuth();
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const now = Date.now();
  const ordered = sessions.filter((session) =>
    `${session.name ?? ""} ${session.cwd} ${session.id}`.toLowerCase().includes(query),
  ).sort((a, b) => {
    // Live sessions first, then most recently active.
    if (a.live !== b.live) return a.live ? -1 : 1;
    return b.modifiedAt - a.modifiedAt;
  });

  return (
    <nav className="app-sidebar" aria-label="Sessions">
      <div className="app-sidebar-head">
        <span className="app-title">pi</span>
        <span className="app-subtitle">workspace</span>
      </div>
      <button
        type="button"
        className="app-sidebar-new"
        onClick={onNewSession}
        title="Start a new session (pick a project directory)"
      >
        <Plus size={16} /> New session
      </button>
      <label className="app-sidebar-search">
        <MagnifyingGlass size={16} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search sessions"
          placeholder="Search sessions"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <div className="app-sidebar-section">Sessions</div>
      <div className="app-sidebar-list" role="listbox" aria-label="Sessions">
        {ordered.length === 0 ? (
          <div className="app-sidebar-empty">{query === "" ? "No sessions yet." : "No matching sessions."}</div>
        ) : null}
        {ordered.map((session) => {
          const selected = session.id === selectedId;
          const running = session.running === true || (selected && selectedRunning === true);
          const state = running ? "running" : session.live ? "live" : "stopped";
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
              title={`${session.name ? `${session.name}\n` : ""}${session.cwd}\n${session.id}${state === "running" ? " — running" : state === "live" ? " — attached" : ""}`}
            >
              <span className={`app-session-dot app-session-dot-${state}`} aria-hidden="true" />
              <span className="app-session-body">
                {/* A session's name replaces the cwd label; the cwd moves to the meta line. */}
                <span className="app-session-name">{session.name ?? shortCwd(session.cwd)}</span>
                <span className="app-session-meta">
                  {session.name !== undefined ? `${shortCwd(session.cwd)} · ` : ""}{session.id.slice(0, 8)}
                </span>
              </span>
              <span className="app-session-time">{relativeTime(session.modifiedAt, now)}</span>
              {state === "running" ? <span className="app-session-running">run</span> : null}
            </button>
          );
        })}
      </div>
      <div className="app-sidebar-footer">
        <Terminal size={15} aria-hidden="true" />
        <span>Local workspace</span>
        <button
          type="button"
          className="app-theme-toggle"
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          aria-label="Toggle dark and light theme"
          onClick={() => {
            setTheme(toggleTheme());
          }}
        >
          {theme === "dark" ? <Moon size={13} weight="fill" /> : <Sun size={13} weight="fill" />}
        </button>
        {auth.required ? (
          <button
            type="button"
            className="app-signout"
            title="Sign out of this pi-web"
            onClick={auth.signOut}
          >
            sign out
          </button>
        ) : null}
      </div>
    </nav>
  );
}
