// Typed fetch layer for the Files panel. Every request carries the session id;
// the server resolves the root and re-validates the path. Returns a
// discriminated result so the UI can tell a real failure from a partial page.

import type { FileKind } from "../../../shared/file-kind.ts";

export type FilesFailure = { ok: false; code: string; message: string; status: number };
export type FilesResult<T> = { ok: true; data: T } | FilesFailure;

export interface DirEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  fileKind?: FileKind;
  size?: number;
  mtimeMs?: number;
}

export interface FilesListData {
  kind: "directory";
  path: string;
  entries: DirEntry[];
  truncated: boolean;
  total: number;
}

export interface FilesTextData {
  kind: "text";
  path: string;
  fileKind: FileKind;
  text: string;
  size: number;
  mtimeMs: number;
  truncated: boolean;
  binary: boolean;
}

export interface FilesSearchData {
  kind: "search";
  query: string;
  matches: Array<{ path: string; name: string }>;
  truncated: boolean;
}

/** The preview header's file identity, derived from a listing or search hit. */
export interface FileRef {
  path: string;
  name: string;
  fileKind: FileKind;
  size?: number;
  mtimeMs?: number;
}

function encode(sessionId: string, path: string): string {
  return encodeURIComponent(path);
}

export function downloadUrl(sessionId: string, path: string, attach: boolean): string {
  const base = `/api/agent/${encodeURIComponent(sessionId)}/files/download?path=${encode(sessionId, path)}`;
  return attach ? `${base}&download=1` : base;
}

async function request<T>(url: string): Promise<FilesResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    return failure("network", "could not reach the server");
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    return {
      ok: false,
      code: typeof body.code === "string" ? body.code : "error",
      message: typeof body.error === "string" ? body.error : `request failed (HTTP ${response.status})`,
      status: response.status,
    };
  }
  return { ok: true, data: body as T };
}

function failure(code: string, message: string): FilesFailure {
  return { ok: false, code, message, status: 0 };
}

export function fetchDirectory(sessionId: string, path: string, hidden: boolean): Promise<FilesResult<FilesListData>> {
  const url = `/api/agent/${encodeURIComponent(sessionId)}/files?path=${encode(sessionId, path)}${hidden ? "&hidden=1" : ""}`;
  return request<FilesListData>(url);
}

export function fetchText(sessionId: string, path: string): Promise<FilesResult<FilesTextData>> {
  return request<FilesTextData>(`/api/agent/${encodeURIComponent(sessionId)}/files/read?path=${encode(sessionId, path)}`);
}

export function fetchSearch(sessionId: string, query: string): Promise<FilesResult<FilesSearchData>> {
  return request<FilesSearchData>(`/api/agent/${encodeURIComponent(sessionId)}/files/search?q=${encodeURIComponent(query)}`);
}

/**
 * Build a preview target from a listing entry, preserving its metadata so the
 * preview header never triggers a wasteful re-read for non-text files.
 */
export function fileRefOf(entry: DirEntry, fileKind: FileKind): FileRef {
  return {
    path: entry.path,
    name: entry.name,
    fileKind: entry.fileKind ?? fileKind,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
  };
}