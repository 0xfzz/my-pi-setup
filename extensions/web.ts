/**
 * web — management commands for the vendored pi-web fork.
 *
 * Implements:
 *   /web start  - Build if needed (or the sources changed), then serve the production build; refuses if already running
 *   /web reload - Stop the managed server, wait for it to go down, start it again (rebuilding if the sources changed)
 *   /web stop   - Stop running pi-web instance if managed, or provide pkill guidance
 *   /web status - Report serving status, owner, URL, and state file agreement
 *
 * While a session runs, edits to the fork's sources or to our web plugins reload a managed
 * server that is up. Set PI_WEB_AUTO_RELOAD=0 to turn that off.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultVendorDir, reloadWebUi, reloadWebUiIfChanged, startWebUi, statusWebUi, stopWebUi, type WebUiDeps } from "../lib/web-ui.ts";
import { repoRootFromVendor, sourceWatchRoots, watchSources, type SourceWatcher } from "../lib/web-ui-reload.ts";

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

  pi.registerCommand("web", {
    description: "Manage pi-web UI server (production build): /web start | reload [--rebuild] | stop | status",
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
    if (!autoReloadEnabled || watcher) return;
    const vendorDir = options.deps?.vendorDir ?? defaultVendorDir();
    watcher = watchSources({
      roots: sourceWatchRoots(vendorDir, repoRootFromVendor(vendorDir)),
      debounceMs: options.autoReloadDebounceMs ?? AUTO_RELOAD_DEBOUNCE_MS,
      onChange: () => {
        void autoReload(ctx);
      },
    });
  });

  pi.on("session_shutdown", () => {
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
