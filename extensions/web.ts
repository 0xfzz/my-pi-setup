/**
 * web — lifecycle management and the live session bridge for the minimal
 * pi-web server.
 *
 * Implements:
 *   /web start  - Build if needed (or the sources changed), then serve the built client; refuses if already running
 *   /web reload - Stop the managed server, wait for it to go down, start it again (rebuilding if the sources changed)
 *   /web stop   - Stop running pi-web instance if managed, or provide pkill guidance
 *   /web status - Report serving status, owner, URL, and state file agreement
 *
 * While a session runs, edits to the server's sources or to our web plugins
 * reload a managed server that is up. Set PI_WEB_AUTO_RELOAD=0 to turn that
 * off.
 *
 * The session bridge: when the web server is reachable (at session start, or
 * right after /web start brings it up), this session attaches to it — one
 * live AgentSession, two frontends. The TUI keeps driving the session as
 * usual; its events stream to the web, and prompts typed in a browser arrive
 * here as bridge commands executed against this same session (pi.sendUserMessage).
 * That is what keeps the web UI and the CLI in sync, in realtime, both ways.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// pi's own share/bug primitives — deep imports, since the package "exports"
// map only opens the main entry. These are pi's code, not reimplementations.
import { exportSessionToJsonl, serializeSessionBranch } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-export.js";
import {
  bugReportArchiveFileName,
  collectBugReportDiagnostics,
  collectBugReportMetadata,
  writeBugReportArchive,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/bug-report.js";
import { uploadBugReport } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/bug-report-upload.js";
import { readCrashLog } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/crash-log.js";
import { getRadiusGatewayUrl, RADIUS_PROVIDER_ID } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/radius.js";
import { getShareViewerUrl } from "../node_modules/@earendil-works/pi-coding-agent/dist/config.js";
import { getAuthCredential } from "../node_modules/@earendil-works/pi-coding-agent/dist/cli/auth-command.js";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT, type ActionRequestPayload } from "../lib/web-plugins/actions.ts";
import { WEB_PLUGIN_VIEW_EVENT, type DialogWebView, type WebView } from "../lib/web-plugins/view.ts";
import { publishWebView } from "../lib/web-plugins/publisher.ts";
import { buildWebTree, type PiTreeNodeLike } from "../lib/web-tree.ts";
import { sseFrameData, takeSseFrames } from "../lib/web-sse.ts";
import { WEB_PLUGIN_UI_SYNC_EVENT, WEB_UI_EVENT } from "../lib/web-plugins/ui-event-models.ts";
import { defaultServerDir, reloadWebUi, reloadWebUiIfChanged, startWebUi, statusWebUi, stopWebUi, type WebUiDeps } from "../lib/web-ui.ts";
import { repoRootFromServerDir, sourceWatchRoots, watchSources, type SourceWatcher } from "../lib/web-ui-reload.ts";
import { WebAuthConfigCache, loadWebAuthConfig, removeWebPassword, webAuthConfigPath, writeWebPassword } from "../lib/web-auth/config.ts";
import { MIN_PASSWORD_LENGTH, passwordProblem } from "../lib/web-auth/password.ts";
import { providerKeyInput } from "../lib/provider/provider-key-input.ts";

export interface WebExtensionOptions {
  deps?: Partial<WebUiDeps>;
  /** Reload on source changes while a session runs. Defaults to on; PI_WEB_AUTO_RELOAD=0 turns it off. */
  autoReload?: boolean;
  /** Quiet period before a change triggers a reload. */
  autoReloadDebounceMs?: number;
  /** Where the web password record lives; defaults to ~/.pi/agent/web-auth.json (PI_WEB_AUTH_FILE overrides). */
  authConfigPath?: string;
  /** Masked password prompt; defaults to the TUI's hidden-input component. Tests inject their own. */
  askSecret?: (ctx: ExtensionContext, title: string) => Promise<string | undefined>;
}

export const AUTO_RELOAD_DEBOUNCE_MS = 2_000;
/** One status line, updated in place while a start, reload or automatic reload runs. */
export const WEB_PROGRESS_STATUS_KEY = "web-reload";

/** Where the minimal web server listens; PI_WEB_URL overrides (tests). */
function bridgeServerUrl(): string {
  return process.env.PI_WEB_URL ?? "http://127.0.0.1:30142";
}

let bridgeAuthCache: WebAuthConfigCache | undefined;

/**
 * Credentials for the bridge routes. With a web password set the server accepts only the
 * bridge token from web-auth.json (a browser session is not enough to drive a session);
 * without one the routes are open and no header is added. Re-read on file change, so a
 * `/web set-password` from any pi session takes effect for all of them.
 */
export function bridgeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const path = webAuthConfigPath();
  if (bridgeAuthCache?.path !== path) bridgeAuthCache = new WebAuthConfigCache(path);
  const loaded = bridgeAuthCache.get();
  return loaded.state === "enabled" ? { ...extra, Authorization: `Bearer ${loaded.config.bridgeToken}` } : extra;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** A minimal structural body type: keeps the extension compiling without DOM lib. */
interface BridgeBodyReader {
  read(): Promise<{ done?: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}
interface BridgeBody {
  getReader(): BridgeBodyReader;
}

/** Context-derived usage, for the web's session state. */
function contextUsageOf(ctx: ExtensionContext): { contextUsage: { percent: number; contextWindow: number; tokens: number } | null } {
  const usage = ctx.getContextUsage?.();
  return {
    contextUsage: usage
      ? { percent: usage.percent ?? 0, contextWindow: usage.contextWindow ?? 0, tokens: usage.tokens ?? 0 }
      : null,
  };
}

/**
 * The bridge never runs under the node test runner: a unit test's mock
 * context is not a real session, and attaching would hit whatever real
 * server happens to be listening on the default port. The repo's
 * established pattern (plugin state paths) gates on NODE_TEST_CONTEXT.
 */
// The web extension can also be loaded inside the web server process itself
// (an in-process resume loads the full extension set). In that process it must
// not bridge, or it would attach the session back to the server it is running
// in and displace the live in-process copy.
const inWebServerProcess = process.env.PI_WEB_SERVER_PROCESS === "1";
const bridgeEnabled = process.env.NODE_TEST_CONTEXT === undefined && !inWebServerProcess;

/** The state snapshot posted when the bridge attaches. */
function bridgeStateOf(ctx: ExtensionContext): Record<string, unknown> {
  return {
    isStreaming: !(ctx.isIdle?.() ?? true),
    model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
    thinkingLevel: ctx.thinkingLevel,
    name: ctx.sessionManager?.getSessionName?.() ?? "",
    ...contextUsageOf(ctx),
  };
}

/** A minimal model reference: enough for the web picker and setModel. */
interface ModelRef {
  provider: string;
  id: string;
}

/**
 * The models the web picker offers — the same set the TUI's selector and
 * Ctrl+P cycling use: the session's scoped models when scoping is active,
 * otherwise everything available (configured auth or local providers).
 */
function modelRefs(ctx: ExtensionContext): ModelRef[] {
  const scoped = ctx.scopedModels ?? [];
  const models = scoped.length > 0 ? scoped.map((scopedModel) => scopedModel.model) : ctx.modelRegistry.getAvailable();
  return models.map((model) => ({ provider: model.provider, id: model.id }));
}

/** Resolve a model reference the way the TUI does: exact `provider/id`, or a
 * unique bare `id` across providers. */
function findModelRef(ctx: ExtensionContext, term: string): ModelRef | undefined {
  const refs = modelRefs(ctx);
  const trimmed = term.trim();
  const exact = refs.find((ref) => `${ref.provider}/${ref.id}` === trimmed);
  if (exact !== undefined) return exact;
  const bare = refs.filter((ref) => ref.id === trimmed);
  return bare.length === 1 ? bare[0] : undefined;
}

/** pi's thinking levels, in cycle order. */
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Push the current model/thinking to the web client (SSE `session_state`). */
async function postBridgeState(sessionId: string, state: Record<string, unknown>): Promise<void> {
  await fetch(`${bridgeServerUrl()}/api/bridge/${encodeURIComponent(sessionId)}/events`, {
    method: "POST",
    headers: bridgeHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ state }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
}

/**
 * Event poster with a 25 ms batch: message_update deltas arrive per token,
 * and one POST per batch keeps the request rate sane.
 */
interface BridgePoster {
  start(): void;
  stop(): void;
  post(event: unknown): void;
}

function createBridgePoster(sessionId: string): BridgePoster {
  let active = false;
  let queue: unknown[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    timer = null;
    if (!active || queue.length === 0) return;
    const events = queue;
    queue = [];
    void fetch(`${bridgeServerUrl()}/api/bridge/${encodeURIComponent(sessionId)}/events`, {
      method: "POST",
      headers: bridgeHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  };
  return {
    start() {
      active = true;
    },
    stop() {
      active = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      queue = [];
    },
    post(event: unknown) {
      if (!active) return;
      queue.push(event);
      if (timer === null) timer = setTimeout(flush, 25);
    },
  };
}

export default function webExtension(pi: ExtensionAPI, options: WebExtensionOptions = {}) {
  const sessionIdOf = (ctx: ExtensionContext): string =>
    (ctx as any)?.sessionManager?.getSessionId?.() ??
    (ctx as any)?.sessionManager?.getHeader?.()?.id ??
    "session";

  const depsFor = (ctx: ExtensionContext): Partial<WebUiDeps> => ({
    sessionId: sessionIdOf(ctx),
    onProgress: (message: string) => {
      if (ctx.hasUI) ctx.ui.setStatus(WEB_PROGRESS_STATUS_KEY, message);
    },
    ...options.deps,
  });

  /** Runs a long pi-web operation with its progress shown in the status line, cleared when it ends. */
  const withProgress = async <T,>(ctx: ExtensionContext, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } finally {
      if (ctx.hasUI) ctx.ui.setStatus(WEB_PROGRESS_STATUS_KEY, undefined);
    }
  };

  let watcher: SourceWatcher | undefined;
  const autoReloadEnabled = options.autoReload !== false && process.env.PI_WEB_AUTO_RELOAD !== "0";

  // --- the live session bridge ----------------------------------------------
  let bridgeController: AbortController | null = null;
  let bridgeSessionId: string | null = null;
  let bridgePoster: BridgePoster | null = null;
  /** True while the attach stream is connected; false between retries. */
  let bridgeStreaming = false;
  /** Self-heal timer: a healthy server with a dead bridge re-attaches. */
  let bridgeWatchdog: ReturnType<typeof setInterval> | null = null;

  const stopBridge = (): void => {
    bridgeController?.abort();
    bridgeController = null;
    bridgePoster?.stop();
    bridgePoster = null;
    bridgeStreaming = false;
    if (bridgeWatchdog !== null) {
      clearInterval(bridgeWatchdog);
      bridgeWatchdog = null;
    }
    const sessionId = bridgeSessionId;
    bridgeSessionId = null;
    if (sessionId !== null) {
      // Best-effort detach so the server drops the session immediately
      // instead of waiting for the connection to notice.
      void fetch(`${bridgeServerUrl()}/api/bridge/${encodeURIComponent(sessionId)}/detach`, {
        method: "POST",
        headers: bridgeHeaders(),
        signal: AbortSignal.timeout(3_000),
      }).catch(() => undefined);
    }
  };
  /**
   * The self-heal: a healthy server with a down bridge re-attaches within
   * one tick. This covers every silent death mode — the retry loop exiting,
   * a missed session_start, a server that started after pi did — because it
   * only trusts the live attach-stream flag, not controller bookkeeping.
   */
  const ensureBridgeWatchdog = (): void => {
    if (!bridgeEnabled || bridgeWatchdog !== null) return;
    bridgeWatchdog = setInterval(() => {
      if (bridgeStreaming) return;
      const ctx = lastCtxForCommands;
      if (ctx === null) return;
      void (async () => {
        try {
          const health = await fetch(`${bridgeServerUrl()}/api/health`, {
            signal: AbortSignal.timeout(1_500),
          });
          if (health.ok) await attachBridge(ctx);
        } catch {
          // Server down: try again next tick.
        }
      })();
    }, 5_000);
  };


  // Push the current model/thinking/context to the web client (SSE `session_state`).
  const postSessionState = (ctx: ExtensionContext): void => {
    bridgePoster?.post({
      type: "session_state",
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
      thinkingLevel: ctx.thinkingLevel,
      ...contextUsageOf(ctx),
    });
  };

  // High-frequency stream events (message/tool deltas) should not POST per
  // token; once a second is plenty for a live context figure.
  let lastStreamStateAt = 0;
  const STREAM_STATE_THROTTLE_MS = 1000;
  const postSessionStateThrottled = (ctx: ExtensionContext): void => {
    const now = Date.now();
    if (now - lastStreamStateAt < STREAM_STATE_THROTTLE_MS) return;
    lastStreamStateAt = now;
    postSessionState(ctx);
  };

  // Push the model list for the web picker (SSE `web_models`).
  const postModelsEvent = (ctx: ExtensionContext): void => {
    bridgePoster?.post({
      type: "web_models",
      current: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
      models: modelRefs(ctx),
    });
  };

  // Apply a model reference to this session and push the fresh state to
  // the web; returns a user-facing message either way.
  const applyModelRef = async (ctx: ExtensionContext, ref: ModelRef): Promise<string> => {
    try {
      const model = ctx.modelRegistry.find(ref.provider, ref.id);
      if (model === undefined) return `model not found: ${ref.provider}/${ref.id}`;
      const applied = await pi.setModel(model);
      if (!applied) return `no auth configured for ${ref.provider}`;
      postSessionState(ctx);
      postModelsEvent(ctx);
      return `model: ${ref.provider}/${ref.id}`;
    } catch (error) {
      return `set model failed: ${String(error)}`;
    }
  };

  const attachBridge = async (ctx: ExtensionContext): Promise<void> => {
    // A connected attach stream is the only reason not to re-attach. A dead
    // loop (server restart mid-stream, a silent drop) must be replaceable —
    // otherwise the bridge never comes back and the web stream stays frozen.
    if (!bridgeEnabled || bridgeStreaming) return;
    try {
      const health = await fetch(`${bridgeServerUrl()}/api/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!health.ok) return;
    } catch {
      // Server not running: the watchdog re-attaches when it comes up.
      ensureBridgeWatchdog();
      return;
    }
    try {
      // Any dead loop's controller must go before starting a fresh one.
      bridgeController?.abort();
      const sessionId = sessionIdOf(ctx);
      bridgeSessionId = sessionId;
      bridgeController = new AbortController();
      bridgePoster = createBridgePoster(sessionId);
      bridgePoster.start();
      void postBridgeState(sessionId, bridgeStateOf(ctx));
      // The session's dispatchable slash commands (extension, prompt
      // templates, skills), so the web composer can offer them.
      try {
        bridgePoster.post({
          type: "web_commands",
          commands: [
            // pi core commands (extension, prompt templates, skills) — the
            // web dispatches these as prompt text through the session's
            // expandPromptTemplates path.
            ...pi
              .getCommands()
              // The web-* registrations are dispatch targets for the bridge
              // channel; the display name below carries them. Hidden
              // picker resolvers never surface.
              .filter((command) => !command.name.startsWith("web-"))
              .map((command) => ({
                name: command.name,
                ...(command.description !== undefined ? { description: command.description } : {}),
              })),
            // web core commands — dispatched through the web's own bridge
            // channel ({type: "web_command"}), never through pi's runner.
            ...WEB_CORE_COMMANDS.map((command) => ({
              name: command.name,
              description: command.description,
              web: true,
            })),
          ],
        });
      } catch {
        // A failed listing must never fail the attach.
      }
      // The model picker's data and the live model/thinking state: the web
      // chip and selector start correct and stay synced with this session.
      try {
        postModelsEvent(ctx);
        postSessionState(ctx);
      } catch {
        // Model listing is best-effort; the picker falls back to fetching.
      }
      void runBridgeStream(ctx, sessionId, bridgeController.signal);
    } catch (error) {
      // The bridge must never take the pi session down with it.
      stopBridge();
      ctxNotify(`web bridge: attach failed: ${String(error)}`);
    }
  };

  const runBridgeStream = async (
    ctx: ExtensionContext,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const query = new URLSearchParams({ cwd: ctx.cwd });
    if (ctx.model) query.set("model", `${ctx.model.provider}/${ctx.model.id}`);
    if (ctx.thinkingLevel) query.set("thinkingLevel", ctx.thinkingLevel);
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    if (sessionFile) query.set("sessionFile", sessionFile);
    let firstAttach = true;
    let retryDelayMs = 1_000;
    while (!signal.aborted) {
      try {
        const res = await fetch(
          `${bridgeServerUrl()}/api/bridge/${encodeURIComponent(sessionId)}/attach?${query.toString()}`,
          { signal, headers: bridgeHeaders({ accept: "text/event-stream" }) },
        );
        if (!res.ok || res.body === null) throw new Error(`attach failed: HTTP ${res.status}`);
        retryDelayMs = 1_000;
        bridgeStreaming = true;
        if (!firstAttach) {
          // The stream survived a drop: the web may have missed events while
          // we were away, so its streams reload their history.
          bridgePoster?.post({ type: "bridge_resync" });
        }
        firstAttach = false;
        await consumeBridgeCommands(sessionId, res.body as unknown as BridgeBody, signal);
      } catch {
        // Network drop or server restart: reconnect below unless detaching.
      }
      // The attach stream ended or dropped — however it happened (including
      // a silent exit), the bridge is down until a retry reconnects.
      bridgeStreaming = false;
      ensureBridgeWatchdog();
      if (signal.aborted) return;
      await sleep(retryDelayMs, signal);
      retryDelayMs = Math.min(retryDelayMs * 2, 10_000);
    }
  };

  const consumeBridgeCommands = async (
    sessionId: string,
    body: BridgeBody,
    signal: AbortSignal,
  ): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const { frames, remainder } = takeSseFrames(buffer);
        buffer = remainder;
        for (const frame of frames) handleBridgeFrame(sessionId, frame);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The stream is already gone.
      }
    }
  };

  const handleBridgeFrame = (sessionId: string, frame: string): void => {
    const data = sseFrameData(frame);
    if (data === "") return; // heartbeat comment
    let parsed: {
      type?: unknown;
      command?: {
        type?: unknown;
        message?: unknown;
        requestId?: unknown;
        pluginId?: unknown;
        actionId?: unknown;
        images?: unknown;
        provider?: unknown;
        id?: unknown;
        level?: unknown;
        name?: unknown;
        args?: unknown;
      };
    };
    try {
      parsed = JSON.parse(data) as typeof parsed;
    } catch {
      return;
    }
    if (parsed.type !== "bridge_command" || parsed.command === undefined) return;
    const command = parsed.command;
    if (command.type === "prompt" && typeof command.message === "string") {
      // A prompt typed in the browser runs on THIS session — the TUI sees
      // the same turn it would see if the user had typed it locally.
      // expandPromptTemplates dispatches "/command …" like the TUI's prompt
      // path; steer queues it when a run is already streaming. Image
      // attachments ride along as content blocks.
      try {
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>
          = [{ type: "text", text: command.message }];
        for (const image of Array.isArray(command.images) ? command.images : []) {
          if (typeof image?.data === "string" && typeof image?.mimeType === "string") {
            content.push({ type: "image", data: image.data, mimeType: image.mimeType });
          }
        }
        pi.sendUserMessage(content, {
          deliverAs: "steer",
          expandPromptTemplates: true,
        });
      } catch (error) {
        ctxNotify(`web bridge: prompt failed: ${String(error)}`);
      }
      return;
    }
    if (command.type === "abort") {
      try {
        lastCtxForCommands?.abort();
      } catch {
        // Already idle.
      }
      return;
    }
    if (
      command.type === "set_model"
      && typeof command.provider === "string"
      && typeof command.id === "string"
    ) {
      const ctx = lastCtxForCommands;
      if (ctx === null) return;
      const ref = findModelRef(ctx, `${command.provider}/${command.id}`);
      if (ref === undefined) {
        ctxNotify(`model not found: ${command.provider}/${command.id}`);
        return;
      }
      void applyModelRef(ctx, ref).then(ctxNotify);
      return;
    }
    if (command.type === "set_thinking" && typeof command.level === "string") {
      const level = command.level as (typeof THINKING_LEVELS)[number];
      if (!THINKING_LEVELS.includes(level)) {
        ctxNotify(`unknown thinking level: ${command.level}`);
        return;
      }
      try {
        pi.setThinkingLevel(level);
        ctxNotify(`thinking level: ${level}`);
        if (lastCtxForCommands !== null) postSessionState(lastCtxForCommands);
      } catch (error) {
        ctxNotify(`set thinking failed: ${String(error)}`);
      }
      return;
    }
    if (
      command.type === "web_command"
      && typeof command.name === "string"
    ) {
      // The web core's own command channel. Runner-dispatched commands go
      // through pi's own command runner (a fresh, valid command context —
      // session control methods only exist there); direct ones run on the
      // captured session context.
      const entry = webCoreCommand(command.name);
      if (entry === undefined) {
        ctxNotify(`unknown web command: ${command.name}`);
        return;
      }
      const args = typeof command.args === "string" ? command.args : "";
      if (entry.dispatch === "runner") {
        // pi.sendUserMessage returns void (fire-and-forget); its errors
        // surface through the runner's own error reporting.
        pi.sendUserMessage(`/web-${command.name}${args.trim() !== "" ? ` ${args.trim()}` : ""}`, {
          expandPromptTemplates: true,
        });
        return;
      }
      const ctx = lastCtxForCommands as WebCommandContext | null;
      if (ctx === null) {
        ctxNotify(`web command ${command.name}: no session context yet`);
        return;
      }
      void Promise.resolve(entry.handler(args, ctx)).catch((error: unknown) => {
        ctxNotify(`web command ${command.name} failed: ${String(error)}`);
      });
      return;
    }
    if (
      command.type === "action" &&
      typeof command.pluginId === "string" &&
      typeof command.actionId === "string"
    ) {
      // Plugin actions from the web reach the TUI-side extensions exactly
      // like in-process ones.
      pi.events?.emit(WEB_PLUGIN_ACTION_REQUEST_EVENT, {
        requestId: typeof command.requestId === "string" ? command.requestId : "",
        sessionId,
        pluginId: command.pluginId,
        actionId: command.actionId,
      });
      return;
    }
    if (command.type === "ui_sync") {
      // The web attached after this session already published its views:
      // re-emit the current UI values (publisher remembers the last value per
      // plugin and re-publishes them on this event).
      pi.events?.emit(WEB_PLUGIN_UI_SYNC_EVENT, {});
      return;
    }
  };

  // Commands arrive outside handler contexts, so the bridge keeps the last
  // session context for abort() and notifications.
  let lastCtxForCommands: ExtensionContext | null = null;
  const ctxNotify = (message: string): void => {
    try {
      lastCtxForCommands?.ui?.notify(message, "warning");
    } catch {
      // A notice that cannot be shown is not worth failing the bridge.
    }
  };

  // Forward the session stream to the web while the bridge is attached.
  const forwardToBridge = (event: unknown): void => {
    bridgePoster?.post(event);
  };
  pi.on("agent_start", (event, ctx) => {
    forwardToBridge(event);
    // The server-side state AND the web client both get the current
    // model/thinking: a turn started is the sync point after any TUI-side
    // change (its own /model, Ctrl+P), and the state fetch on settle would
    // otherwise resurrect the attach-time model.
    if (bridgeSessionId !== null) {
      void postBridgeState(bridgeSessionId, {
        isStreaming: true,
        model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
        thinkingLevel: ctx.thinkingLevel,
      });
    }
    postSessionState(ctx);
  });
  // The session's name for the web sidebar: a /name, a rename, or a generated title.
  pi.on("session_info_changed", (event) => {
    bridgePoster?.post({ type: "session_name", name: event.name ?? "" });
  });
  pi.on("agent_end", forwardToBridge);
  // A tree navigation (/tree, a fork): the session's position moved — the
  // web's transcript must reload to the new branch, like the TUI redraws.
  pi.on("session_tree", forwardToBridge);
  pi.on("ui_prompt_start", forwardToBridge);
  pi.on("ui_prompt_end", forwardToBridge);
  pi.on("agent_settled", (event, ctx) => {
    forwardToBridge(event);
    if (bridgeSessionId !== null) {
      void postBridgeState(bridgeSessionId, {
        isStreaming: false,
        model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
        thinkingLevel: ctx.thinkingLevel,
        ...contextUsageOf(ctx),
      });
    }
  });
  pi.on("message_start", forwardToBridge);
  pi.on("message_update", (event, ctx) => {
    forwardToBridge(event);
    if (bridgeSessionId !== null) postSessionStateThrottled(ctx);
  });
  pi.on("message_end", forwardToBridge);
  pi.on("tool_execution_start", forwardToBridge);
  pi.on("tool_execution_update", (event, ctx) => {
    forwardToBridge(event);
    if (bridgeSessionId !== null) postSessionStateThrottled(ctx);
  });
  pi.on("tool_execution_end", forwardToBridge);
  // User-run bash (`!` commands): pi's extension events only announce the
  // command, so the web extension supplies pi's local shell as custom
  // operations and wraps it — the TUI keeps its own stream (onData is
  // forwarded), while the web receives the same live deltas plus a closing
  // event with the output and exit code, exactly like the wire's projection
  // of `entry_appended` for in-process sessions.
  pi.on("user_bash", (event) => {
    forwardToBridge({
      type: "user_bash",
      command: event.command,
      excludeFromContext: event.excludeFromContext,
      cwd: event.cwd,
    });
    const local = createLocalBashOperations({ shellPath: pi.getSettings().shellPath });
    return {
      operations: {
        exec: async (command: string, cwd: string, options: {
          onData: (data: Buffer) => void;
          signal?: AbortSignal;
          timeout?: number;
          env?: NodeJS.ProcessEnv;
        }) => {
          let output = "";
          const result = await local.exec(command, cwd, {
            ...options,
            onData: (data: Buffer) => {
              const delta = data.toString("utf-8");
              output += delta;
              forwardToBridge({ type: "bash_execution_update", delta });
              options.onData(data);
            },
          });
          forwardToBridge({
            type: "bash_execution_end",
            command: event.command,
            output: output.length > 8_000 ? `${output.slice(0, 8_000)}…` : output,
            exitCode: typeof result.exitCode === "number" ? result.exitCode : undefined,
            cancelled: false,
            truncated: false,
          });
          return result;
        },
      },
    };
  });
  // Plugin views and UI events from the TUI-side publishers, so the web's
  // plugin surfaces work for a bridged session exactly like an in-process one.
  pi.events?.on(WEB_PLUGIN_VIEW_EVENT, (payload: unknown) => {
    bridgePoster?.post({ type: "web_plugin_view", payload });
  });
  pi.events?.on(WEB_UI_EVENT, (payload: unknown) => {
    bridgePoster?.post({ type: "web_ui_event", payload });
  });

  // ── The web core command registry ────────────────────────────────────────
  // pi's interactive built-ins, wired for the web. Two kinds:
  //
  //  runner — needs pi's COMMAND context (newSession, fork, navigateTree,
  //  switchSession, reload exist only there). Registered as real pi
  //  commands under prefixed names (web-<name>) so the TUI's own built-ins
  //  keep their names, and dispatched through pi's own runner:
  //  pi.sendUserMessage("/web-<name>", {expandPromptTemplates: true}) →
  //  AgentSession._tryExecuteExtensionCommand → the handler with a fresh,
  //  valid command context. Never a stale captured ctx.
  //
  //  direct — runs on the plain extension context (compact, setSessionName,
  //  shutdown all exist there); the bridge channel executes it directly.
  type WebCommandContext = ExtensionContext & {
    waitForIdle(): Promise<void>;
    newSession(): Promise<{ cancelled: boolean }>;
    fork(entryId: string, options: { position: string }): Promise<{ cancelled: boolean }>;
    navigateTree(targetId: string): Promise<{ cancelled: boolean }>;
    switchSession(sessionPath: string): Promise<void>;
    reload(): Promise<void>;
  };
  const WEB_CORE_COMMANDS: Array<{
    name: string;
    description: string;
    /** "runner" dispatches through pi's command runner; "direct" runs on the captured ctx. */
    dispatch: "runner" | "direct";
    handler: (args: string, ctx: WebCommandContext) => void | Promise<void>;
  }> = [
    {
      name: "compact",
      dispatch: "direct",
      description: "Compact the session context (web core)",
      handler: (args, ctx) => {
        const instructions = args.trim();
        ctx.compact(instructions !== "" ? { customInstructions: instructions } : undefined);
      },
    },
    {
      name: "name",
      dispatch: "direct",
      description: "Set the session display name (web core)",
      handler: (args) => {
        const name = args.trim();
        if (name === "") {
          ctxNotify("usage: /name <new-name>");
          return;
        }
        pi.setSessionName(name);
        ctxNotify(`session name: ${name}`);
      },
    },
    {
      name: "new",
      dispatch: "runner",
      description: "Start a new session (web core)",
      handler: async (_args, ctx) => {
        const result = await ctx.newSession();
        if (result.cancelled) ctxNotify("new session cancelled");
      },
    },
    {
      name: "clone",
      dispatch: "runner",
      description: "Duplicate the current session at the current position (web core)",
      handler: async (_args, ctx) => {
        const leafId = ctx.sessionManager?.getLeafId?.();
        if (leafId === undefined || leafId === null) {
          ctxNotify("nothing to clone yet");
          return;
        }
        try {
          const result = await ctx.fork(leafId, { position: "at" });
          if (result.cancelled) ctxNotify("clone cancelled");
          else ctxNotify("cloned to new session");
        } catch (error) {
          ctxNotify(`clone failed: ${String(error)}`);
        }
      },
    },
    {
      name: "reload",
      dispatch: "runner",
      description: "Reload keybindings, extensions, skills, prompts and themes (web core)",
      handler: async (_args, ctx) => {
        try {
          // The TUI's reload refuses to run mid-turn or mid-compaction (it
          // just warns and returns). The web dispatches a one-shot command, so
          // instead of silently no-op'ing, wait for the session to settle first.
          await ctx.waitForIdle();
          await ctx.reload();
          ctxNotify("reloaded");
        } catch (error) {
          ctxNotify(`reload failed: ${String(error)}`);
        }
      },
    },
    {
      // pi's /fork: pick a previous user message, branch there. The picker
      // is the web dialog pipeline (pi's extension dialog surface): both
      // frontends render it, either can answer, and the pick resolves
      // through ctx.fork — pi's own branching API.
      name: "fork",
      dispatch: "runner",
      description: "Fork from a previous user message (web core)",
      handler: (_args, ctx) => {
        const entries = ctx.sessionManager?.getEntries?.() ?? [];
        const userMessages = entries.flatMap((entry) => {
          if (entry.type !== "message" || entry.message.role !== "user") return [];
          return [{
            id: entry.id,
            message: entry.message as { role: string; content: unknown },
          }];
        });
        if (userMessages.length === 0) {
          ctxNotify("no user messages to fork from yet");
          return;
        }
        const actions = userMessages.slice(-50).reverse().map((entry) => {
          const content = entry.message.content;
          const text =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .filter(
                      (block): block is { type?: string; text?: string } =>
                        typeof block === "object" && block !== null,
                    )
                    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
                    .join(" ")
                    .trim()
                : "";
          return { id: `fork@${entry.id}`, label: `${text.slice(0, 60) || "(empty)"} · ${entry.id.slice(0, 8)}` };
        });
        publishWebView(pi, WEB_CORE_PLUGIN_ID, pickerDialog("Fork from which message?", actions.map((a) => a.label), actions));
      },
    },
    {
      // pi's /tree: navigate the session's branch structure. Bare: pi's own
      // tree (getTree) projected the way its TUI selector shapes it — the
      // web renders its picker from that data. With an entry id (the pick):
      // pi's navigateTree moves there.
      name: "tree",
      dispatch: "runner",
      description: "Navigate the session tree (web core)",
      handler: async (args, ctx) => {
        const targetId = args.trim();
        if (targetId !== "") {
          try {
            const result = await ctx.navigateTree(targetId);
            if (result.cancelled) ctxNotify("tree navigation cancelled");
            else ctxNotify(`navigated to ${targetId.slice(0, 8)}`);
          } catch (error) {
            ctxNotify(`tree navigation failed: ${String(error)}`);
          }
          return;
        }
        const manager = ctx.sessionManager;
        const tree = manager?.getTree?.() ?? [];
        if (tree.length === 0) {
          ctxNotify("the session tree is empty");
          return;
        }
        const leafId = manager?.getLeafId?.() ?? null;
        const nodes = buildWebTree(tree as unknown as readonly PiTreeNodeLike[], leafId);
        bridgePoster?.post({ type: "web_tree", nodes });
      },
    },
    {
      // pi's /import: resume a session from a JSONL file. The path as the
      // command's argument (the web composer's palette offers the hint);
      // the takeover through pi's switchSession.
      name: "import",
      dispatch: "runner",
      description: "Import and resume a session from a JSONL file (web core)",
      handler: async (args, ctx) => {
        const path = args.trim();
        if (path === "") {
          ctxNotify("usage: /import /path/to/session.jsonl");
          return;
        }
        try {
          await ctx.switchSession(path);
          ctxNotify(`resumed ${path}`);
        } catch (error) {
          ctxNotify(`import failed: ${String(error)}`);
        }
      },
    },
    {
      // pi's /quit: the graceful shutdown pi itself exposes on the context.
      name: "quit",
      dispatch: "direct",
      description: "Gracefully shut down this pi session (web core)",
      handler: async (_args, ctx) => {
        ctxNotify("shutting down");
        ctx.shutdown();
      },
    },
    {
      // pi's /share: export the session branch (pi's exportSessionToJsonl)
      // and hand the URL to Radius or a GitHub gist. The result is a web
      // dialog carrying the share URL — no terminal loader.
      name: "share",
      dispatch: "direct",
      description: "Share the session via Radius or a GitHub gist (web core)",
      handler: async (_args, ctx) => {
        await runShare(ctx);
      },
    },
    {
      // pi's /bug: build pi's own bug-report bundle (metadata + diagnostics
      // + session branch) and upload it or write a zip, then report the
      // result. args is JSON: {description?, delivery? "upload"|"zip"}.
      name: "bug",
      dispatch: "direct",
      description: "Report a bug to the Pi developers (web core)",
      handler: async (args, ctx) => {
        await runBug(args, ctx);
      },
    },
  ];
  const webCoreCommand = (name: string): (typeof WEB_CORE_COMMANDS)[number] | undefined =>
    WEB_CORE_COMMANDS.find((command) => command.name === name);

  // The web dialog pipeline's dialog for the core pickers: entries as
  // actions, answered from either frontend through the plugin action
  // pipeline — pi's extension dialog surface, no bespoke protocol.
  const WEB_CORE_PLUGIN_ID = "web-core";
  const pickerDialog = (title: string, labels: string[], actions: Array<{ id: string; label: string }>): WebView => {
    // The dialog contract caps actions at 8: the newest 7 entries are
    // pickable (a cancel action takes the last slot); the rest are listed
    // as lines for context.
    const view: DialogWebView = {
      type: "dialog",
      title,
      lines: labels.length > 7 ? labels.slice(7, 20) : [],
      actions: [
        ...actions.slice(0, 7).map((action) => ({
          id: action.id,
          label: action.label.slice(0, 60),
        })),
        { id: "web-core-cancel", label: "Cancel" },
      ],
      open: true,
    };
    return view;
  };

  // A simple result dialog (no picker): lines + a Close action. Used by
  // /share and /bug to hand a URL or report id back to the web frontend.
  const resultDialog = (title: string, lines: string[]): WebView => ({
    type: "dialog",
    title,
    lines,
    actions: [{ id: "web-core-close", label: "Close" }],
    open: true,
  });

  // The Radus/share trailing entry: the session's system prompt and tool
  // schemas, so the viewer renders tool calls. Built from the extension's
  // own surfaces (ctx.getSystemPrompt + pi.getAllTools) — pi's own data.
  const shareTrailingEntries = (ctx: WebCommandContext): ((parentId: string | null, timestamp: string) => readonly object[]) => {
    const tools = pi
      .getAllTools()
      .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
    const systemPrompt = ctx.getSystemPrompt();
    return (parentId, timestamp) => [{
      type: "custom",
      customType: "pi.share",
      id: randomUUID().slice(0, 8),
      parentId,
      timestamp,
      data: { systemPrompt, tools },
    }];
  };

  const tryShareViaRadius = async (jsonlFile: string, ctx: WebCommandContext): Promise<string | null> => {
    try {
      const auth = await ctx.modelRegistry.getProviderAuth(RADIUS_PROVIDER_ID);
      const token = getAuthCredential(auth);
      if (!token) return null;
      const body = readFileSync(jsonlFile);
      const url = new URL("/v1/artifacts", getRadiusGatewayUrl());
      url.searchParams.set("visibility", "organization");
      url.searchParams.set("title", "Pi session");
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/x-ndjson",
          "Content-Length": String(body.byteLength),
        },
        body,
      });
      const json = (await response.json().catch(() => null)) as { artifact?: { canonical_url?: string } } | null;
      if (!response.ok || !json?.artifact?.canonical_url) return null;
      return json.artifact.canonical_url;
    } catch {
      return null;
    }
  };

  const shareViaGist = (jsonlFile: string): Promise<string | null> =>
    new Promise((resolve) => {
      const proc = spawn("gh", ["gist", "create", "--public=false", jsonlFile]);
      let stdout = "";
      proc.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      proc.on("error", () => resolve(null));
      proc.on("close", (code) => resolve(code === 0 ? stdout.trim() : null));
    });

  const runShare = async (ctx: WebCommandContext): Promise<void> => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-share-"));
    const jsonlFile = join(tmpDir, "session.jsonl");
    try {
      const exportJsonl = exportSessionToJsonl as unknown as (
        sm: unknown,
        outputPath: string,
        trailing: (parentId: string | null, timestamp: string) => readonly object[],
      ) => string;
      exportJsonl(ctx.sessionManager, jsonlFile, shareTrailingEntries(ctx));
      const destination = pi.getSettings().sessionShareDestination ?? "auto";
      if (destination !== "gist") {
        const radiusUrl = await tryShareViaRadius(jsonlFile, ctx);
        if (radiusUrl !== null) {
          publishWebView(pi, WEB_CORE_PLUGIN_ID, resultDialog("Share complete", [`Share URL: ${radiusUrl}`]));
          return;
        }
        if (destination === "radius") {
          publishWebView(pi, WEB_CORE_PLUGIN_ID, resultDialog("Share failed", ["Radius authentication is not configured. Run /login radius first."]));
          return;
        }
      }
      const gistUrl = await shareViaGist(jsonlFile);
      if (gistUrl === null || gistUrl === "") {
        publishWebView(pi, WEB_CORE_PLUGIN_ID, resultDialog("Share failed", ["GitHub CLI (gh) is not installed or not logged in. Run 'gh auth login' first."]));
        return;
      }
      const gistId = gistUrl.split("/").pop();
      const previewUrl = gistId !== undefined && gistId !== "" ? getShareViewerUrl(gistId) : gistUrl;
      publishWebView(pi, WEB_CORE_PLUGIN_ID, resultDialog("Share complete", [`Share URL: ${previewUrl}`, `Gist: ${gistUrl}`]));
    } catch (error) {
      publishWebView(pi, WEB_CORE_PLUGIN_ID, resultDialog("Share failed", [error instanceof Error ? error.message : String(error)]));
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // tmp cleanup is best-effort
      }
    }
  };

  const runBug = async (args: string, ctx: WebCommandContext): Promise<void> => {
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(args);
    } catch {
      // Plain text: "--zip <description>" chooses a local zip, otherwise
      // the description is the rest of the line and delivery is upload.
      const trimmed = args.trim();
      if (trimmed.startsWith("--zip")) parsed = { delivery: "zip", description: trimmed.slice(4).trim() };
      else parsed = { description: trimmed };
    }
    const request = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
      description?: unknown;
      delivery?: unknown;
    };
    const description = typeof request.description === "string" && request.description.trim() !== "" ? request.description.trim() : undefined;
    const delivery = request.delivery === "zip" ? "zip" : "upload";
    try {
      const settings = SettingsManager.create(ctx.cwd, getAgentDir());
      const collectMetadata = collectBugReportMetadata as unknown as (
        options: Record<string, unknown>,
      ) => { id: string };
      const sessionManager = ctx.sessionManager as unknown as {
        getEntries(): Array<{ type: string }>;
      } & { getSessionId?: () => string };
      const metadata = collectMetadata({
        hint: description,
        sessionId: sessionManager.getSessionId?.() ?? "session",
        cwd: ctx.cwd,
        includeSession: true,
        includeSummary: false,
        messageCount: sessionManager.getEntries().filter((entry) => entry.type === "message").length,
        model: ctx.model,
        modelRuntime: {
          getProvider: (id: string) => ctx.modelRegistry.getProvider(id),
          getProviderAuthStatus: (id: string) => ctx.modelRegistry.getProviderAuthStatus(id),
          isUsingOAuth: (id: string) => {
            const model = ctx.modelRegistry.getAll().find((candidate) => candidate.provider === id);
            return model !== undefined ? ctx.modelRegistry.isUsingOAuth(model) : false;
          },
          getRegisteredProviderIds: () => ctx.modelRegistry.getRegisteredProviderIds(),
        },
        thinkingLevel: ctx.thinkingLevel ?? "off",
        extensions: [],
        extensionErrors: [],
        globalSettings: settings.getGlobalSettings(),
        projectSettings: settings.getProjectSettings(),
      });
      const diagnostics = collectBugReportDiagnostics(ctx.sessionManager as never, readCrashLog());
      const sessionJsonl = (serializeSessionBranch as unknown as (
        sm: unknown,
        trailing?: (parentId: string | null, timestamp: string) => readonly object[],
      ) => string)(ctx.sessionManager, shareTrailingEntries(ctx));
      const bundle = { metadata, diagnostics, sessionJsonl };
      if (delivery === "upload") {
        const result = await uploadBugReport(bundle as never, { signal: AbortSignal.timeout(30_000) });
        publishWebView(pi, WEB_CORE_PLUGIN_ID, resultDialog("Bug report uploaded", [`Report ID: ${result.id}`]));
      } else {
        const outPath = join(process.cwd(), bugReportArchiveFileName((metadata as { id: string }).id));
        await writeBugReportArchive(bundle as never, outPath);
        publishWebView(pi, WEB_CORE_PLUGIN_ID, resultDialog("Bug report exported", [`Saved to: ${outPath}`]));
      }
    } catch (error) {
      publishWebView(pi, WEB_CORE_PLUGIN_ID, resultDialog("Bug report failed", [error instanceof Error ? error.message : String(error)]));
    }
  };

  // A picker's answer: the action id encodes <kind>@<entryId>. Dispatch
  // through pi's own command runner (the hidden web-core-fork/tree
  // commands) so the handler runs with a fresh, valid command context —
  // never a captured one that may have gone stale across session switches.
  pi.events?.on(WEB_PLUGIN_ACTION_REQUEST_EVENT, (data: unknown) => {
    const request = data as Partial<ActionRequestPayload> | undefined;
    if (request?.pluginId !== WEB_CORE_PLUGIN_ID) return;
    const actionId = typeof request.actionId === "string" ? request.actionId : "";
    if (actionId === "web-core-cancel" || actionId === "web-core-close") {
      void publishWebView(pi, WEB_CORE_PLUGIN_ID, { type: "dialog", open: false });
    } else if (actionId.startsWith("fork@")) {
      const entryId = actionId.slice("fork@".length);
      void publishWebView(pi, WEB_CORE_PLUGIN_ID, { type: "dialog", open: false });
      pi.sendUserMessage(`/web-core-fork ${entryId}`, { expandPromptTemplates: true });
    } else if (actionId.startsWith("tree@")) {
      const targetId = actionId.slice("tree@".length);
      void publishWebView(pi, WEB_CORE_PLUGIN_ID, { type: "dialog", open: false });
      pi.sendUserMessage(`/web-tree ${targetId}`, { expandPromptTemplates: true });
    }
  });

  // /model and /thinking are fully web-ported: the composer intercepts them
  // client-side (bare opens the picker, args POST to the model/thinking
  // routes), and the bridge's set_model/set_thinking commands apply them —
  // so no pi command registration and no dialog-request round trip.

  // The runner-dispatched web core commands: real pi commands under
  // prefixed names. pi's TUI built-ins keep their own names; these are the
  // web's dispatch targets and also work typed directly in the TUI. The
  // hidden web-core-fork/tree pair resolves picker actions (never listed).
  for (const command of WEB_CORE_COMMANDS) {
    if (command.dispatch !== "runner") continue;
    pi.registerCommand(`web-${command.name}`, {
      description: command.description,
      handler: async (args: string, ctx: ExtensionContext) => {
        await command.handler(args, ctx as WebCommandContext);
      },
    });
  }
  pi.registerCommand("web-core-fork", {
    description: "Resolve a web fork picker action (internal).",
    handler: async (args: string, ctx: ExtensionContext) => {
      const entryId = args.trim();
      if (entryId === "") return;
      const result = await (ctx as WebCommandContext).fork(entryId, { position: "before" });
      if (result.cancelled) ctxNotify("fork cancelled");
      else ctxNotify("forked to a new session");
    },
  });


  const authPath = (): string => options.authConfigPath ?? webAuthConfigPath();

  /** Prompt for a secret without echo; undefined when cancelled or when no masked input exists. */
  const askSecret = async (ctx: ExtensionContext, title: string): Promise<string | undefined> => {
    if (options.askSecret !== undefined) return options.askSecret(ctx, title);
    try {
      return await providerKeyInput(ctx as never, title);
    } catch {
      ctx.ui?.notify("/web set-password needs the interactive terminal (hidden input is not available here).", "warning");
      return undefined;
    }
  };

  const setPassword = async (ctx: ExtensionContext, extraArgs: string[]): Promise<void> => {
    if (extraArgs.length > 0) {
      // Typed arguments land in the editor history and, when run from the web, the session
      // transcript. The password is only ever entered into the hidden prompt.
      ctx.ui?.notify("Do not put the password on the command line: it would be kept in your history. Run /web set-password on its own and type it when asked.", "warning");
      return;
    }
    const first = await askSecret(ctx, `New web password (at least ${MIN_PASSWORD_LENGTH} characters)`);
    if (first === undefined) return;
    const problem = passwordProblem(first);
    if (problem !== null) {
      ctx.ui?.notify(`That password is not acceptable: ${problem}. Nothing was changed.`, "warning");
      return;
    }
    const again = await askSecret(ctx, "Repeat the web password");
    if (again === undefined) return;
    if (again !== first) {
      ctx.ui?.notify("The two passwords differ. Nothing was changed.", "warning");
      return;
    }
    const existed = loadWebAuthConfig(authPath()).state !== "disabled";
    try {
      await writeWebPassword(first, authPath());
    } catch (error) {
      ctx.ui?.notify(`Could not save the web password: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    ctx.ui?.notify(
      [
        existed ? "Web password changed; every web session was signed out." : "Web password set. pi-web now asks everyone to sign in.",
        "A running pi-web applies it immediately, no restart needed.",
        "To reach it from other machines run pi with PI_WEB_HOST=0.0.0.0, or put a TLS proxy or tunnel in front (see docs/pi-web.md).",
      ].join("\n"),
      "info",
    );
  };

  const clearPassword = async (ctx: ExtensionContext): Promise<void> => {
    if (loadWebAuthConfig(authPath()).state === "disabled") {
      ctx.ui?.notify("No web password is set.", "info");
      return;
    }
    const confirmed = (await ctx.ui?.confirm("Remove the web password?", "pi-web will be open to anyone who can reach it.")) ?? false;
    if (!confirmed) return;
    removeWebPassword(authPath());
    ctx.ui?.notify("Web password removed. pi-web is open again.", "info");
  };

  const protectionLine = (): string => {
    const state = loadWebAuthConfig(authPath()).state;
    if (state === "enabled") return "Password protection: on (/web set-password to change, /web clear-password to remove)";
    if (state === "invalid") return "Password protection: BROKEN — the password file is unreadable and the server refuses requests. Run /web set-password again.";
    return "Password protection: off (/web set-password to turn on)";
  };

  pi.registerCommand("web", {
    description: "Manage pi-web UI server (built client): /web start | reload [--rebuild] | stop | status | set-password | clear-password",
    getArgumentCompletions(prefix) {
      const subcommands = ["start", "reload", "stop", "status", "set-password", "clear-password"];
      const matching = subcommands.filter((sub) => sub.startsWith(prefix.trim().toLowerCase()));
      return matching.map((sub) => ({ value: sub, label: sub }));
    },
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase() || "status";
      const rebuild = parts.slice(1).some((flag) => flag === "--rebuild" || flag === "--build");
      const deps = depsFor(ctx);

      if (sub === "start") {
        const result = await withProgress(ctx, () => startWebUi({ ...deps, rebuild }));
        const level = result.status === "denied" ? "warning" : result.status === "error" ? "error" : "info";
        ctx.ui?.notify(result.message, level);
        if (result.status !== "error") {
          // Serving now (ours or an already-healthy instance): bridge this
          // session so the web and the TUI stay in sync.
          lastCtxForCommands = ctx;
          void attachBridge(ctx);
        }
        return;
      }

      if (sub === "reload") {
        const result = await withProgress(ctx, () => reloadWebUi({ ...deps, rebuild }));
        const level = result.status === "error" ? "error" : result.status === "denied" ? "warning" : "info";
        ctx.ui?.notify(result.message, level);
        return;
      }

      if (sub === "stop") {
        const result = await stopWebUi(deps);
        const level = result.status === "error" ? "error" : "info";
        ctx.ui?.notify(result.message, level);
        return;
      }

      if (sub === "status") {
        const result = await statusWebUi(deps);
        ctx.ui?.notify(`${result.message}\n${protectionLine()}`, "info");
        return;
      }

      if (sub === "set-password") {
        await setPassword(ctx, parts.slice(1));
        return;
      }

      if (sub === "clear-password") {
        await clearPassword(ctx);
        return;
      }

      ctx.ui?.notify(
        `Unknown subcommand "${sub}". Usage: /web start | reload | stop | status | set-password | clear-password`,
        "warning",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    lastCtxForCommands = ctx;
    // Inside the web server process the extension is loaded as part of an
    // in-process session resume; it must not self-bridge or watch sources.
    if (inWebServerProcess) return;
    if (autoReloadEnabled && !watcher) {
      const serverDir = options.deps?.serverDir ?? defaultServerDir();
      watcher = watchSources({
        roots: sourceWatchRoots(serverDir, repoRootFromServerDir(serverDir)),
        debounceMs: options.autoReloadDebounceMs ?? AUTO_RELOAD_DEBOUNCE_MS,
        onChange: () => {
          void autoReload(ctx);
        },
      });
    }
    // Sync this live session with the web UI whenever the server is up.
    void attachBridge(ctx);
  });

  pi.on("session_shutdown", () => {
    stopBridge();
    watcher?.close();
    watcher = undefined;
  });

  async function autoReload(ctx: ExtensionContext): Promise<void> {
    const result = await withProgress(ctx, () => reloadWebUiIfChanged(depsFor(ctx)));
    // Only a reload that actually ran has a message; idle, unchanged and busy stay quiet.
    if (!("message" in result)) return;
    const level = result.status === "error" ? "error" : "info";
    // The session may have moved on; a notice that cannot be shown is not worth failing over.
    try {
      ctx.ui?.notify(`Source change: ${result.message}`, level);
    } catch {
      // ignored
    }
  }
}
