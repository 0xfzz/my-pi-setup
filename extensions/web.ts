/**
 * web — management commands for the vendored pi-web fork.
 *
 * Implements:
 *   /web start  - Build if needed, then serve the production build; refuses if already running
 *   /web stop   - Stop running pi-web instance if managed, or provide pkill guidance
 *   /web status - Report serving status, owner, URL, and state file agreement
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startWebUi, statusWebUi, stopWebUi, type WebUiDeps } from "../lib/web-ui.ts";

export interface WebExtensionOptions {
  deps?: Partial<WebUiDeps>;
}

export default function webExtension(pi: ExtensionAPI, options: WebExtensionOptions = {}) {
  pi.registerCommand("web", {
    description: "Manage pi-web UI server (production build): /web start [--rebuild] | stop | status",
    getArgumentCompletions(prefix) {
      const subcommands = ["start", "stop", "status"];
      const matching = subcommands.filter((sub) => sub.startsWith(prefix.trim().toLowerCase()));
      return matching.map((sub) => ({ value: sub, label: sub }));
    },
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase() || "status";
      const rebuild = parts.slice(1).some((flag) => flag === "--rebuild" || flag === "--build");
      const sessionId =
        (ctx as any)?.sessionManager?.getSessionId?.() ??
        (ctx as any)?.sessionManager?.getHeader?.()?.id ??
        "session";

      const deps: Partial<WebUiDeps> = {
        sessionId,
        ...options.deps,
      };

      if (sub === "start") {
        const result = await startWebUi({ ...deps, rebuild });
        const level = result.status === "denied" ? "warning" : result.status === "error" ? "error" : "info";
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
        `Unknown subcommand "${sub}". Usage: /web start | stop | status`,
        "warning",
      );
    },
  });
}
