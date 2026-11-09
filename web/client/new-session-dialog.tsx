// New-session dialog: pick the project directory a fresh session runs in.
// Recent projects from the session list, a directory browser (navigate into
// subdirectories, up to the parent), and a free-form path input.

import { useCallback, useEffect, useState } from "react";
import type { SessionSummary } from "./use-session.ts";

interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
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

  // Recent projects: unique cwds, most recently active first.
  const recent = [...new Map(
    [...sessions].sort((a, b) => b.modifiedAt - a.modifiedAt).map((s) => [s.cwd, s.cwd]),
  ).keys()].slice(0, 6);

  const load = useCallback(async (path: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/directories?path=${encodeURIComponent(path)}`);
      const body = (await res.json()) as DirectoryListing & { error?: string };
      if (!res.ok) {
        setError(body.error ?? `could not list ${path}`);
        return;
      }
      setListing(body);
      setPathInput(body.path);
    } catch {
      setError("could not reach the server");
    }
  }, []);

  useEffect(() => {
    if (open && listing === null) void load(recent[0] ?? "/home");
    if (!open) {
      setListing(null);
      setError(null);
    }
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
    <div className="app-dialog-backdrop" onClick={onClose} role="presentation">
      <div
        className="app-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Start a new session"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="app-dialog-head">
          <span className="app-dialog-title">New session</span>
          <button type="button" className="app-dialog-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {recent.length > 0 ? (
          <div className="app-dialog-section">
            <div className="app-dialog-label">Recent projects</div>
            <div className="app-dialog-recent">
              {recent.map((cwd) => (
                <button
                  key={cwd}
                  type="button"
                  className="app-dialog-recent-item"
                  onClick={() => void load(cwd)}
                  title={cwd}
                >
                  {cwd.split("/").filter(Boolean).pop() ?? cwd}
                </button>
              ))}
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
              className="app-dialog-browse"
              onClick={() => void load(pathInput)}
              title="Browse this directory"
            >
              browse
            </button>
          </div>
          {error ? <div className="app-dialog-error" role="alert">{error}</div> : null}
        </div>

        {listing !== null ? (
          <div className="app-dialog-browser">
            <div className="app-dialog-browser-head">
              <button
                type="button"
                className="app-dialog-up"
                disabled={listing.parent === null}
                onClick={() => listing.parent !== null && void load(listing.parent)}
                title="Parent directory"
              >
                ↑ up
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
                  onClick={() => void load(entry.path)}
                  title={entry.path}
                >
                  <span aria-hidden="true">📁</span> {entry.name}
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
  );
}
