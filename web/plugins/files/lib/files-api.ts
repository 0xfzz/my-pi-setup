// Typed fetch layer for the Files panel. Every request carries the session id
// and goes to the plugin's own backend surface, /api/p/files/* — registered by
// this plugin's server half, not a core route. Returns a discriminated result
// so the UI can tell a real failure from a partial page.

import type { FileKind } from "../../../core/shared/file-kind.ts";
import { getJson, type ApiFailure, type ApiResult } from "../../../core/client/plugin-system/api-client.ts";
import { FILES_API_PATH } from "../contract.ts";

export type FilesFailure = ApiFailure;
export type FilesResult<T> = ApiResult<T>;

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

function encode(path: string): string {
  return encodeURIComponent(path);
}

/** `?sessionId=…` — the plugin route contract's session scope. */
function scope(sessionId: string): string {
  return `sessionId=${encodeURIComponent(sessionId)}`;
}

export function downloadUrl(sessionId: string, path: string, attach: boolean): string {
  const base = `${FILES_API_PATH}/download?${scope(sessionId)}&path=${encode(path)}`;
  return attach ? `${base}&download=1` : base;
}

export function fetchDirectory(sessionId: string, path: string, hidden: boolean): Promise<FilesResult<FilesListData>> {
  const url = `${FILES_API_PATH}?${scope(sessionId)}&path=${encode(path)}${hidden ? "&hidden=1" : ""}`;
  return getJson<FilesListData>(url);
}

export function fetchText(sessionId: string, path: string): Promise<FilesResult<FilesTextData>> {
  return getJson<FilesTextData>(`${FILES_API_PATH}/read?${scope(sessionId)}&path=${encode(path)}`);
}

export function fetchSearch(sessionId: string, query: string): Promise<FilesResult<FilesSearchData>> {
  return getJson<FilesSearchData>(`${FILES_API_PATH}/search?${scope(sessionId)}&q=${encodeURIComponent(query)}`);
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