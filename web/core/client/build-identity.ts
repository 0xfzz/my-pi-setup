// Which client build a page is running, and when to move to another one.
//
// `/app.js` and `/app.css` are fixed file names, so a browser cannot tell from
// a response which build it holds. The server stamps the shell it serves with a
// build id (`<meta name="pi-web-build">`) and reports the id it serves on the
// session-directory stream. A page compares the two: when they differ, the
// server has a newer bundle and this page reloads onto it. Without that, a tab
// left open across a rebuild keeps running the plugin code it was opened with
// while every new tab runs the current code.

/** The id stamped into this page's HTML, or null when it carries none. */
export function ownBuildId(doc: Document): string | null {
  const content = doc.querySelector(`meta[name="pi-web-build"]`)?.getAttribute("content")?.trim();
  return content !== undefined && content !== "" ? content : null;
}

export type BuildVerdict =
  /** Same build: nothing to do. */
  | "current"
  /** The server serves a newer build: reload onto it. */
  | "stale"
  /** Already reloaded for this build and the page still does not match: stop. */
  | "reloaded";

/**
 * Decide whether a page should reload onto `served`.
 *
 * `lastReloaded` is the build id this tab already reloaded for. A mismatch
 * after that reload means the served id and the stamped id cannot converge
 * (a rebuild that keeps landing, or a build that stamps nothing); reloading
 * again would spin the tab, so the caller stops instead and says so.
 */
export function buildVerdict(own: string | null, served: string | null, lastReloaded: string | null): BuildVerdict {
  // No stamp (a dev server, an old build) or nothing served: no comparison is
  // possible, and guessing would reload on every connect.
  if (own === null || served === null || served === "") return "current";
  if (own === served) return "current";
  if (lastReloaded === served) return "reloaded";
  return "stale";
}
