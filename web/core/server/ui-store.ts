// The unified per-session UI store and its durable floor.
//
// One store holds everything the browser renders per session: plugin views,
// the working model, statuses, widgets, popups and toasts. Producers (pi
// extensions, the host itself) publish into it; the SSE stream reads snapshots.
//
// The store's view values survive a server restart: on boot the previous
// values are restored, then every accepted change is persisted (debounced).
// The owning pi process still re-emits fresher values on every attach, so the
// file is a floor the UI stands on until that live value lands — a disk-only
// session keeps rendering its last known UI.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebUiStore } from "../plugin-contracts/ui-state-store.ts";
import { extensionUiUpdate } from "../plugin-contracts/ui-event-models.ts";
import type { WebView } from "../plugin-contracts/view.ts";

const GLOBAL_STORE_KEY = Symbol.for("pi-web:unified-ui:v1");
const PERSIST_DEBOUNCE_MS = 200;

/** One store per process, even if this module is evaluated twice. */
function sharedStore(): WebUiStore {
  const global = globalThis as Record<PropertyKey, unknown>;
  global[GLOBAL_STORE_KEY] ??= new WebUiStore();
  return global[GLOBAL_STORE_KEY] as WebUiStore;
}

export const webUiStore: WebUiStore = sharedStore();

interface PersistedWebUiState {
  version: 1;
  views: Record<string, Record<string, WebView>>;
}

const EMPTY_STATE: PersistedWebUiState = { version: 1, views: {} };

/**
 * The server's own plugin-view file. It is deliberately NOT the extension's web
 * management state (web-ui-state.json): they shared one path once, the server's
 * `{version, views}` write clobbered the extension's `{pid, port, url, …}`
 * record, and /web reload then refused a healthy server as unmanaged.
 */
function webUiStatePath(): string {
  // A caller that isolates its state (the e2e suites, a second instance) points
  // this at its own directory: the store is a durable floor, so without an
  // override every run inherits whatever the last one left on screen.
  if (process.env.PI_WEB_UI_STATE) return process.env.PI_WEB_UI_STATE;
  // Test processes get their own file so a suite never writes into a real home dir.
  if (process.env.NODE_TEST_CONTEXT) {
    return join(tmpdir(), "pi-web-ui-state", `${process.pid}.json`);
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "web-plugin-ui-state.json");
}

function isViewMap(value: unknown): value is PersistedWebUiState["views"] {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePersistedState(text: string): PersistedWebUiState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return EMPTY_STATE;
  }
  if (typeof parsed !== "object" || parsed === null) return EMPTY_STATE;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || !isViewMap(record.views)) return EMPTY_STATE;
  return { version: 1, views: record.views };
}

/** The persisted floor, or an empty one. A missing or corrupt file is not fatal. */
function readPersistedState(): PersistedWebUiState {
  try {
    return parsePersistedState(readFileSync(webUiStatePath(), "utf8"));
  } catch {
    return EMPTY_STATE;
  }
}

/** Atomic write: a temp file beside the target, then a rename. */
function writePersistedState(state: PersistedWebUiState): void {
  const path = webUiStatePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  renameSync(tmp, path);
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Coalesce a burst of store changes into one write. */
function schedulePersist(): void {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      writePersistedState({ version: 1, views: webUiStore.persistableViews() });
    } catch {
      // The durable backup is best-effort; UI delivery never depends on the disk.
    }
  }, PERSIST_DEBOUNCE_MS);
}

webUiStore.restoreViews(readPersistedState().views);
webUiStore.subscribe(() => schedulePersist());

/**
 * Project one pi event from the agent stream into the unified UI state:
 * extension UI requests and their closures, plus the session lifecycle flag.
 */
export function recordExtensionUi(sessionId: string, event: Record<string, unknown>): void {
  switch (event.type) {
    case "extension_ui_request": {
      const update = extensionUiUpdate(event);
      if (update) webUiStore.publish(sessionId, update.type, update.payload, update.sourceKey);
      return;
    }
    case "extension_ui_closed":
      webUiStore.publish(sessionId, "ui.custom.changed", { id: event.id, method: "closed", lines: null }, String(event.id));
      return;
    case "agent_start":
    case "agent_end":
    case "agent_settled":
    case "session_shutdown":
      webUiStore.publish(
        sessionId,
        "ui.session.lifecycle",
        { running: event.type === "agent_start", closed: event.type === "session_shutdown" },
        "lifecycle",
        "host",
      );
      return;
    default:
      return;
  }
}

/** The `ctx.ui.working` indicator, published by the host on the extension's behalf. */
export function recordWorkingUi(sessionId: string, payload: unknown): boolean {
  return webUiStore.publish(sessionId, "ui.working.changed", payload, "ctx.ui.working");
}
