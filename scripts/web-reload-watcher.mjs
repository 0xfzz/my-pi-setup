// Detached source watcher for pi-web. It is started by `/web start`, not by a
// terminal session, so editing web code is detected even when no pi TUI is open.
//
// The watcher never owns a session or a listening socket. It watches the same
// fingerprints the command layer uses, asks the running server what a restart
// would cost, and leaves the reload decision to `reloadWebUiIfChanged`.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defaultWebUiStatePath, reloadWebUiIfChanged, webRootUrl } from "../lib/web-ui.ts";
import { parseReloadState, repoRootFromServerDir, sourceWatchRoots, watchSources } from "../lib/web-ui-reload.ts";
import { WebAuthConfigCache, webAuthConfigPath } from "../web/core/auth/config.ts";

const DEBOUNCE_MS = 2_000;
/** A deferred restart is retried after this long; the blocker may close without a file save. */
const RETRY_MS = 5_000;

const serverDir = resolve(process.argv[2] ?? fileURLToPath(new URL("../web", import.meta.url)));
const statePath = process.argv[3] ?? defaultWebUiStatePath();
const authCache = new WebAuthConfigCache(webAuthConfigPath());

function bridgeHeaders() {
  const loaded = authCache.get();
  return loaded.state === "enabled" ? { Authorization: `Bearer ${loaded.config.bridgeToken}` } : {};
}

async function fetchReloadState() {
  try {
    const res = await fetch(`${webRootUrl()}/api/reload-state`, {
      headers: bridgeHeaders(),
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok ? parseReloadState(await res.json()) : null;
  } catch {
    return null;
  }
}

async function notifyReloading(message) {
  const res = await fetch(`${webRootUrl()}/api/reload-notice`, {
    method: "POST",
    headers: { ...bridgeHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!res.ok) throw new Error(`reload notice returned ${res.status}`);
}

let retryTimer;
let running = false;

async function attemptReload() {
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  if (running) return;
  running = true;
  try {
    const result = await reloadWebUiIfChanged({ statePath, serverDir, fetchReloadState, notifyReloading });
    if (result.status === "deferred") {
      retryTimer = setTimeout(() => void attemptReload(), RETRY_MS);
    }
  } finally {
    running = false;
  }
}

const watcher = watchSources({
  roots: sourceWatchRoots(serverDir, repoRootFromServerDir(serverDir), process.env),
  debounceMs: DEBOUNCE_MS,
  onChange: () => void attemptReload(),
});

function stop() {
  watcher.close();
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  process.exit(0);
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
