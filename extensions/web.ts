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
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT } from "../lib/web-plugins/actions.ts";
import { WEB_PLUGIN_VIEW_EVENT } from "../lib/web-plugins/view.ts";
import { WEB_UI_EVENT } from "../lib/web-plugins/ui-event-models.ts";
import { defaultServerDir, reloadWebUi, reloadWebUiIfChanged, startWebUi, statusWebUi, stopWebUi, type WebUiDeps } from "../lib/web-ui.ts";
import { repoRootFromServerDir, sourceWatchRoots, watchSources, type SourceWatcher } from "../lib/web-ui-reload.ts";

export interface WebExtensionOptions {
  deps?: Partial<WebUiDeps>;
  /** Reload on source changes while a session runs. Defaults to on; PI_WEB_AUTO_RELOAD=0 turns it off. */
  autoReload?: boolean;
  /** Quiet period before a change triggers a reload. */
  autoReloadDebounceMs?: number;
}

export const AUTO_RELOAD_DEBOUNCE_MS = 2_000;
/** One status line, updated in place while a start, reload or automatic reload runs. */
export const WEB_PROGRESS_STATUS_KEY = "web-reload";

/** Where the minimal web server listens; PI_WEB_URL overrides (tests). */
function bridgeServerUrl(): string {
  return process.env.PI_WEB_URL ?? "http://127.0.0.1:30142";
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
const bridgeEnabled = process.env.NODE_TEST_CONTEXT === undefined;

/** The state snapshot posted when the bridge attaches. */
function bridgeStateOf(ctx: ExtensionContext): Record<string, unknown> {
  return {
    isStreaming: !(ctx.isIdle?.() ?? true),
    model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
    thinkingLevel: ctx.thinkingLevel,
    ...contextUsageOf(ctx),
  };
}

async function postBridgeState(sessionId: string, state: Record<string, unknown>): Promise<void> {
  await fetch(`${bridgeServerUrl()}/api/bridge/${encodeURIComponent(sessionId)}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
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

  const stopBridge = (): void => {
    bridgeController?.abort();
    bridgeController = null;
    bridgePoster?.stop();
    bridgePoster = null;
    const sessionId = bridgeSessionId;
    bridgeSessionId = null;
    if (sessionId !== null) {
      // Best-effort detach so the server drops the session immediately
      // instead of waiting for the connection to notice.
      void fetch(`${bridgeServerUrl()}/api/bridge/${encodeURIComponent(sessionId)}/detach`, {
        method: "POST",
        signal: AbortSignal.timeout(3_000),
      }).catch(() => undefined);
    }
  };

  const attachBridge = async (ctx: ExtensionContext): Promise<void> => {
    if (!bridgeEnabled || bridgeController !== null) return;
    try {
      const health = await fetch(`${bridgeServerUrl()}/api/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!health.ok) return;
    } catch {
      // Server not running: /web start attaches when it brings it up.
      return;
    }
    try {
      const sessionId = sessionIdOf(ctx);
      bridgeSessionId = sessionId;
      bridgeController = new AbortController();
      bridgePoster = createBridgePoster(sessionId);
      bridgePoster.start();
      void postBridgeState(sessionId, bridgeStateOf(ctx));
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
          { signal, headers: { accept: "text/event-stream" } },
        );
        if (!res.ok || res.body === null) throw new Error(`attach failed: HTTP ${res.status}`);
        retryDelayMs = 1_000;
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
        let separator = buffer.indexOf("\n\n");
        while (separator >= 0) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          handleBridgeFrame(sessionId, frame);
          separator = buffer.indexOf("\n\n");
        }
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
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data === "") return; // heartbeat comment
    let parsed: {
      type?: unknown;
      command?: {
        type?: unknown;
        message?: unknown;
        requestId?: unknown;
        pluginId?: unknown;
        actionId?: unknown;
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
      try {
        pi.sendUserMessage(command.message);
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
  pi.on("agent_start", (event) => {
    forwardToBridge(event);
    if (bridgeSessionId !== null) void postBridgeState(bridgeSessionId, { isStreaming: true });
  });
  pi.on("agent_end", forwardToBridge);
  pi.on("agent_settled", (event, ctx) => {
    forwardToBridge(event);
    if (bridgeSessionId !== null) {
      void postBridgeState(bridgeSessionId, { isStreaming: false, ...contextUsageOf(ctx) });
    }
  });
  pi.on("message_start", forwardToBridge);
  pi.on("message_update", forwardToBridge);
  pi.on("message_end", forwardToBridge);
  pi.on("tool_execution_start", forwardToBridge);
  pi.on("tool_execution_update", forwardToBridge);
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

  pi.registerCommand("web", {
    description: "Manage pi-web UI server (built client): /web start | reload [--rebuild] | stop | status",
    getArgumentCompletions(prefix) {
      const subcommands = ["start", "reload", "stop", "status"];
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
        ctx.ui?.notify(result.message, "info");
        return;
      }

      ctx.ui?.notify(
        `Unknown subcommand "${sub}". Usage: /web start | reload | stop | status`,
        "warning",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    lastCtxForCommands = ctx;
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
