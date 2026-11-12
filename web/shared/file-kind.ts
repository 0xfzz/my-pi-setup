// File classification and limits shared by the Files server and client.
// Pure extension/basename decisions — no filesystem or platform access — so
// both sides agree on what a path is before the server ever reads it.

export type FileKind = "text" | "markdown" | "image" | "pdf" | "audio" | "video" | "binary";

/** Text previews read at most this many bytes (filesystem cost guard). */
export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
/** Raster images larger than this are metadata + download only. */
export const IMAGE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
/** PDFs larger than this download instead of rendering inline (v1). */
export const PDF_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
/** One directory page. A larger listing must be paged, never truncated silently. */
export const MAX_DIR_ENTRIES = 500;
/** Filename-search results per response. */
export const MAX_SEARCH_RESULTS = 200;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".oga", ".flac", ".m4a", ".aac"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".webm", ".mov", ".avi", ".mkv"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown"]);

/** Source/config text formats shown read-only (and HTML/SVG only as source). */
const TEXT_EXTENSIONS = new Set([
  ".txt", ".log", ".json", ".jsonc", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".css", ".scss", ".less", ".html", ".htm", ".svg", ".xml", ".yaml", ".yml",
  ".toml", ".ini", ".sh", ".bash", ".zsh", ".fish", ".py", ".rb", ".go", ".rs",
  ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sql", ".graphql",
  ".env", ".conf", ".cnf", ".properties", ".proto", ".vue", ".svelte", ".dart",
]);

/** Extensionless files whose conventional basename marks them as text. */
const TEXT_BASENAMES = new Set([
  "makefile", "dockerfile", "license", "license.md", "readme", "readme.md",
  "changelog", "changelog.md", "gitignore", "gitattributes", "editorconfig",
  "dockerignore", "npmrc",
]);

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  if (index <= 0) return "";
  return name.slice(index).toLowerCase();
}

export function classifyFile(name: string): FileKind {
  const ext = extensionOf(name);
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (ext === "" && TEXT_BASENAMES.has(name.toLowerCase())) return "text";
  return "binary";
}

/**
 * An allowlisted content type for in-tab rendering and download. Returns null
 * for unknown/executable-ish content, which the server forces to download as
 * an attachment with `application/octet-stream`.
 */
export function mimeTypeFor(name: string): string | null {
  const ext = extensionOf(name);
  const kind = classifyFile(name);
  switch (kind) {
    case "text":
    case "markdown":
      return {
        ".html": "text/html; charset=utf-8",
        ".htm": "text/html; charset=utf-8",
        ".svg": "image/svg+xml",
        ".json": "application/json; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".xml": "application/xml; charset=utf-8",
      }[ext] ?? "text/plain; charset=utf-8";
    case "image":
      return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
        ".ico": "image/x-icon",
      }[ext] ?? null;
    case "pdf":
      return "application/pdf";
    case "audio":
      return {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".oga": "audio/ogg",
        ".flac": "audio/flac",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
      }[ext] ?? null;
    case "video":
      return {
        ".mp4": "video/mp4",
        ".m4v": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
      }[ext] ?? null;
    default:
      return null;
  }
}