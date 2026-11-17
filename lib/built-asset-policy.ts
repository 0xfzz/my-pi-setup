// Static roots contain trusted build outputs, never session/project files.

const PLUGIN_PAGE_PATH = /^\/plugins\/[a-z0-9][a-z0-9.-]*$/;
const STATIC_ASSET_EXTENSIONS = new Set([
  ".bcmap", ".css", ".gif", ".html", ".ico", ".jpeg", ".jpg", ".js",
  ".json", ".map", ".mjs", ".png", ".svg", ".wasm", ".webp", ".woff", ".woff2",
]);

function extensionOf(path: string): string {
  const segment = path.split("/").pop() ?? "";
  const dot = segment.lastIndexOf(".");
  return dot <= 0 ? "" : segment.slice(dot).toLowerCase();
}

/** Routes that may fall back to the SPA shell when no built asset matches. */
export function isSpaFallbackPath(path: string): boolean {
  const extension = extensionOf(path);
  if (extension === "") return true;
  return PLUGIN_PAGE_PATH.test(path) && !STATIC_ASSET_EXTENSIONS.has(extension);
}

/** Explicitly avoid new validators, range responses, caching and redirects. */
export const BUILT_ASSET_OPTIONS = {
  etag: false,
  lastModified: false,
  acceptRanges: false,
  cacheControl: false,
  redirect: false,
  dotfiles: "deny" as const,
  suppressWarning: true, // A missing build root is supported before first build.
};

/** Lexical policy only; @fastify/static owns URL-to-file resolution. */
export function assetPathname(url: string): string | null {
  try {
    const path = decodeURIComponent(url.split("?")[0] ?? "/");
    if (path.includes("\0") || path.includes("\\")) return null;
    if (path.split("/").some(segment => segment.startsWith("."))) return null;
    return path;
  } catch {
    return null;
  }
}

export function isStaticMiss(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return false;
  return typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500;
}

