// New-session dialog: pick the project directory a fresh session runs in.
// Recent projects from the session list, a directory browser (navigate into
// subdirectories, up to the parent), and a free-form path input.

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Folder, X } from "@phosphor-icons/react";
import type { SessionSummary } from "./use-session.ts";
import { LoadingSpinner } from "./plugin-system/LoadingSpinner.tsx";
import { useModalFocus } from "./dialogs.tsx";

interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
}

function recentPathParts(cwd: string): { name: string; parent: string } {
  const parts = cwd.split("/").filter(Boolean);
  return {
    name: parts.at(-1) ?? cwd,
    parent: parts.length > 1 ? `/${parts.slice(0, -1).join("/")}` : "/",
  };
}

export interface NewSessionDialogProps {
  open: boolean;
  sessions: SessionSummary[];
  onClose: () => void;
  /** Returns an error message, or null on success (the session got selected). */
  onStart: (cwd: string) => Promise<string | null>;
}

export function NewSessionDialog({ open, sessions, onClose, onStart }: NewSessionDialogProps) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [loading, setLoading] = useState(false);
  const directoryRequest = useRef<AbortController | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useModalFocus(backdropRef, { onClose, initialFocusRef: closeRef, enabled: open });

  // Recent projects: unique cwds, most recently active first.
  const recent = [...new Map(
    [...sessions].sort((a, b) => b.modifiedAt - a.modifiedAt).map((s) => [s.cwd, s.cwd]),
  ).keys()].slice(0, 6);

  const load = useCallback(async (path: string) => {
    directoryRequest.current?.abort();
    const request = new AbortController();
    directoryRequest.current = request;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/directories?path=${encodeURIComponent(path)}`, { signal: request.signal });
      const body = (await res.json()) as DirectoryListing & { error?: string };
      if (request.signal.aborted) return;
      if (!res.ok) {
        setError(body.error ?? `could not list ${path}`);
        return;
      }
      setListing(body);
      setPathInput(body.path);
    } catch {
      if (!request.signal.aborted) setError("could not reach the server");
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && listing === null) void load(recent[0] ?? "/home");
    if (!open) {
      setListing(null);
      setError(null);
      setLoading(false);
    }
    return () => directoryRequest.current?.abort();
    // recent[0] intentionally not a dep: load once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const start = async (): Promise<void> => {
    const cwd = pathInput.trim();
    if (cwd === "") {
      setError("enter a project directory");
      return;
    }
    setStarting(true);
    const result = await onStart(cwd);
    setStarting(false);
    if (result !== null) {
      setError(result);
      return;
    }
    onClose();
  };

  return (
    <div
      ref={backdropRef}
      data-modal-root
      tabIndex={-1}
      className="app-dialog-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="app-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Start a new session"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="app-dialog-body app-dialog-scroll">
        <div className="app-dialog-head">
          <span className="app-dialog-title">New session</span>
          <button ref={closeRef} type="button" className="app-dialog-close" onClick={onClose} aria-label="Close dialog">
            <X size={14} />
          </button>
        </div>

        {recent.length > 0 ? (
          <div className="app-dialog-section">
            <div className="app-dialog-label">Recent projects</div>
            <div className="app-dialog-recent">
              {recent.map((cwd) => {
                const { name, parent } = recentPathParts(cwd);
                return (
                  <button
                    key={cwd}
                    type="button"
                    className="app-dialog-recent-item"
                    onClick={() => void load(cwd)}
                    title={cwd}
                  >
                    <span className="app-dialog-recent-name">{name}</span>
                    <span className="app-dialog-recent-path">{parent}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="app-dialog-section">
          <div className="app-dialog-label">Project directory</div>
          <div className="app-dialog-path-row">
            <input
              className="app-dialog-path-input"
              value={pathInput}
              onChange={(event) => setPathInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void start();
              }}
              placeholder="/home/you/projects/my-project"
              aria-label="Project directory"
              spellCheck={false}
            />
            <button
              type="button"
              className={`app-dialog-browse${listing !== null ? " app-dialog-expanded" : ""}`}
              onClick={() => {
                if (listing !== null && listing.path === pathInput.trim()) setListing(null);
                else void load(pathInput);
              }}
              title="Browse this directory"
              aria-expanded={listing !== null}
              aria-controls="new-session-directory-browser"
            >
              {listing !== null ? "Hide directories" : "Browse directories"}
            </button>
          </div>
          {error ? <div className="app-dialog-error" role="alert">{error}</div> : null}
        </div>

        {loading ? <div className="app-dialog-empty"><LoadingSpinner label="Loading directories…" /></div> : null}
        {listing !== null ? (
          <div id="new-session-directory-browser" className="app-dialog-browser" aria-busy={loading}>
            <div className="app-dialog-browser-head">
              <button
                type="button"
                className="app-dialog-up"
                disabled={loading || listing.parent === null}
                onClick={() => listing.parent !== null && void load(listing.parent)}
                title="Parent directory"
              >
                <ArrowUp size={13} weight="bold" /> up
              </button>
              <span className="app-dialog-browser-path" title={listing.path}>
                {listing.path}
              </span>
            </div>
            <div className="app-dialog-entries">
              {listing.entries.length === 0 ? (
                <div className="app-dialog-entries-empty">No subdirectories.</div>
              ) : null}
              {listing.entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className="app-dialog-entry"
                  disabled={loading}
                  onClick={() => void load(entry.path)}
                  title={entry.path}
                >
                  <Folder size={14} /> {entry.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="app-dialog-actions">
          <button
            type="button"
            className="app-dialog-start"
            disabled={starting}
            onClick={() => void start()}
          >
            {starting ? "Starting…" : "Start session"}
          </button>
        </div>
        </div>
      </div>
    </div>
  );
}
