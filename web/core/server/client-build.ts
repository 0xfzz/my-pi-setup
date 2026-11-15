// The identity of the client bundle a server is serving.
//
// `/app.js` and `/app.css` are fixed file names, so nothing in a request tells
// a browser which build it is looking at. The build writes `dist/build.json`
// next to them; the server reports that id on `/api/health` and on the session
// directory's snapshot, and pushes a frame when it changes. A page that was
// loaded from an older bundle can then notice the server serves a newer one
// and reload onto it — instead of one tab running last week's plugin code next
// to a tab that was opened a minute ago.

import { readFileSync, statSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";

/** What the build records about itself. */
export interface ClientBuild {
  buildId: string;
  builtAt: string;
}

const BUILD_FILE = "build.json";

/** The meta tag the server stamps into the served shell, so a page knows its own build. */
export const BUILD_META_NAME = "pi-web-build";

/**
 * Mark the served HTML with the build it belongs to. The shell is a fixed file
 * with fixed asset names, so without this stamp a page has no way to name the
 * bundle it is running — and no way to notice the server has moved on.
 */
export function stampBuildId(html: string, buildId: string): string {
  const meta = `<meta name="${BUILD_META_NAME}" content="${buildId}" />`;
  return html.includes("</head>") ? html.replace("</head>", `  ${meta}\n</head>`) : `${meta}\n${html}`;
}

/**
 * The directory this process serves static assets from. A server serves one
 * directory, so this is process state like the boot id; the build id itself is
 * read from disk on demand, because a rebuild replaces it while the process
 * keeps running and the served assets change with it.
 */
let servedRoot: string | null = null;

/** Record the directory this process serves. Called once by `startWebServer`. */
export function setServedRoot(root: string): void {
  servedRoot = root;
}

/** The build currently on disk under the served root, or null when there is none. */
export function servedClientBuild(): ClientBuild | null {
  return servedRoot === null ? null : readClientBuild(servedRoot);
}

/**
 * Read the build id beside the served assets, or null when there is none (a
 * dev server with no production build, or a build from before this file
 * existed). A malformed record is null too: a wrong id would make every open
 * page reload on a loop.
 */
export function readClientBuild(distDir: string): ClientBuild | null {
  try {
    const parsed = JSON.parse(readFileSync(join(distDir, BUILD_FILE), "utf8")) as Partial<ClientBuild>;
    if (typeof parsed.buildId !== "string" || parsed.buildId === "") return null;
    return { buildId: parsed.buildId, builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : "" };
  } catch {
    return null;
  }
}

/**
 * Watch the build record and call `onChange` with the new build whenever it
 * changes on disk. Polling (`watchFile`) rather than `fs.watch`: a build
 * replaces the file, and a watch bound to the old inode goes silent.
 *
 * Returns a stop function. A missing record is not watched: a server with no
 * build has nothing to compare against.
 */
export function watchClientBuild(distDir: string, onChange: (build: ClientBuild) => void): () => void {
  const path = join(distDir, BUILD_FILE);
  try {
    statSync(path);
  } catch {
    return () => {};
  }
  let last = readClientBuild(distDir)?.buildId ?? "";
  const listener = (): void => {
    const build = readClientBuild(distDir);
    if (build === null || build.buildId === last) return;
    last = build.buildId;
    onChange(build);
  };
  watchFile(path, { interval: 1_000, persistent: false }, listener);
  return () => {
    unwatchFile(path, listener);
  };
}
