// Directory browser for the Files panel: breadcrumbs, a hidden-files toggle,
// filename search, and a folders-first listing. Directories are read lazily
// (one listing per navigation) and symlinks are shown as unsupported instead
// of being followed.

import { useEffect, useState } from "react";
import {
  ArrowCounterClockwise, File, FileAudio, FileCode, FileImage, FilePdf, FileText,
  FileVideo, Folder, MagnifyingGlass, X,
} from "@phosphor-icons/react";
import type { FileKind } from "../../core/shared/file-kind.ts";
import { classifyFile } from "../../core/shared/file-kind.ts";
import {
  fetchDirectory, fetchSearch, fileRefOf,
  type DirEntry, type FileRef, type FilesListData,
} from "./files-api.ts";
import { LoadingSpinner } from "../../core/client/plugin-system/LoadingSpinner.tsx";

function fileIcon(fileKind: FileKind | undefined) {
  switch (fileKind) {
    case "image": return <FileImage size={15} aria-hidden="true" />;
    case "pdf": return <FilePdf size={15} aria-hidden="true" />;
    case "audio": return <FileAudio size={15} aria-hidden="true" />;
    case "video": return <FileVideo size={15} aria-hidden="true" />;
    case "markdown":
    case "text": return <FileText size={15} aria-hidden="true" />;
    default: return <FileCode size={15} aria-hidden="true" />;
  }
}

interface FileBrowserProps {
  sessionId: string;
  onOpenFile: (file: FileRef) => void;
}

function breadcrumbParts(path: string): Array<{ label: string; path: string }> {
  if (path === "") return [];
  return path.split("/").map((segment, index, parts) => ({
    label: segment,
    path: parts.slice(0, index + 1).join("/"),
  }));
}

export function FileBrowser({ sessionId, onOpenFile }: FileBrowserProps) {
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<FilesListData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Array<{ path: string; name: string }>>([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchPending, setSearchPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchDirectory(sessionId, path, hidden)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setError(result.message);
          setListing(null);
        } else {
          setListing(result.data);
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, path, hidden]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setMatches([]);
      setSearchTruncated(false);
      setSearchPending(false);
      return;
    }
    let cancelled = false;
    setSearchPending(true);
    const timer = setTimeout(() => {
      void fetchSearch(sessionId, trimmed).then((result) => {
        if (cancelled) return;
        setSearchPending(false);
        if (result.ok) {
          setMatches(result.data.matches);
          setSearchTruncated(result.data.truncated);
        }
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, query]);

  const searching = query.trim() !== "";
  const crumbs = breadcrumbParts(path);
  const openFile = (entry: DirEntry): void => {
    onOpenFile(fileRefOf(entry, classifyFile(entry.name)));
  };

  return (
    <div className="files-browser" data-testid="files-browser">
      <div className="files-toolbar">
        <div className="files-breadcrumbs" aria-label="Current directory">
          <button type="button" className="files-breadcrumb" onClick={() => setPath("")}>
            <Folder size={14} aria-hidden="true" /> Home
          </button>
          {crumbs.map((crumb) => (
            <span key={crumb.path} className="files-breadcrumb-group">
              <span className="files-breadcrumb-sep">/</span>
              <button
                type="button"
                className="files-breadcrumb"
                onClick={() => setPath(crumb.path)}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </div>
        <button
          type="button"
          className="files-icon-btn"
          title="Refresh"
          aria-label="Refresh"
          onClick={() => {
            setListing(null);
            setLoading(true);
            void fetchDirectory(sessionId, path, hidden).then((result) => {
              if (result.ok) setListing(result.data);
              else setError(result.message);
              setLoading(false);
            });
          }}
        >
          <ArrowCounterClockwise size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="files-toolbar">
        <label className="files-search">
          <MagnifyingGlass size={15} aria-hidden="true" />
          <input
            type="search"
            className="files-search-input"
            placeholder="Search filenames"
            aria-label="Search filenames"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {searchPending ? <LoadingSpinner size={14} /> : null}
          {searching ? (
            <button
              type="button"
              className="files-search-clear"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              <X size={14} aria-hidden="true" />
            </button>
          ) : null}
        </label>
        <label className="files-hidden-toggle">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(event) => setHidden(event.target.checked)}
          />
          Hidden
        </label>
      </div>

      {searching ? (
        <div className="files-list" role="listbox" aria-label="Search results">
          {matches.map((match) => (
            <button
              key={match.path}
              type="button"
              className="files-row"
              onClick={() => onOpenFile({ path: match.path, name: match.name, fileKind: classifyFile(match.name) })}
            >
              <span className="files-row-icon">{fileIcon(classifyFile(match.name))}</span>
              <span className="files-row-name">{match.path}</span>
            </button>
          ))}
          {matches.length === 0 ? (
            <div className="files-empty">No matching files.</div>
          ) : null}
          {searchTruncated ? (
            <div className="files-truncated">Search limited to the first results.</div>
          ) : null}
        </div>
      ) : (
        <div className="files-list" role="listbox" aria-label="Files">
          {loading ? <div className="files-empty"><LoadingSpinner label="Loading files…" /></div> : null}
          {error !== null ? (
            <div className="files-empty files-error" role="alert">{error}</div>
          ) : null}
          {!loading && error === null && listing !== null ? (
            <>
              {listing.entries.map((entry) => {
                if (entry.kind === "directory") {
                  return (
                    <button
                      key={entry.path}
                      type="button"
                      className="files-row"
                      onClick={() => setPath(entry.path)}
                    >
                      <span className="files-row-icon files-row-icon-dir"><Folder size={15} aria-hidden="true" /></span>
                      <span className="files-row-name">{entry.name}</span>
                    </button>
                  );
                }
                if (entry.kind === "file") {
                  return (
                    <button
                      key={entry.path}
                      type="button"
                      className="files-row"
                      onClick={() => openFile(entry)}
                    >
                      <span className="files-row-icon">{fileIcon(entry.fileKind ?? classifyFile(entry.name))}</span>
                      <span className="files-row-name">{entry.name}</span>
                    </button>
                  );
                }
                return (
                  <div key={entry.path} className="files-row files-row-disabled" title="Unsupported entry">
                    <span className="files-row-icon"><File size={15} aria-hidden="true" /></span>
                    <span className="files-row-name">{entry.name}</span>
                    <span className="files-row-hint">unsupported</span>
                  </div>
                );
              })}
              {listing.entries.length === 0 ? (
                <div className="files-empty">This folder is empty.</div>
              ) : null}
              {listing.truncated ? (
                <div className="files-truncated">
                  Showing the first {listing.entries.length} of {listing.total} entries.
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}