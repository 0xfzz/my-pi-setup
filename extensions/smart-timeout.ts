import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createBashToolDefinition, createLocalBashOperations, getAgentDir, SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  DEFAULT_TIMEOUT_CONFIG, formatBashCallWithTimeout, formatTimeoutStamp, smartOperations,
  validateConfig, type TimeoutConfig, type TimeoutReport,
} from "../lib/smart-timeout.ts";

export default function smartTimeoutExtension(pi: ExtensionAPI) {
  const path = join(getAgentDir(), "smart-timeout.json");
  let config: TimeoutConfig = { ...DEFAULT_TIMEOUT_CONFIG };
  let configError: string | undefined;
  try {
    config = validateConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") configError = String(error);
  }
  const active = new Set<AbortController>();
  const definition = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...definition,
    description: `${definition.description} Smart timeout: default ${config.defaultSeconds}s total and ${config.idleSeconds}s without output. An explicit timeout disables the silence cutoff, but cannot exceed ${config.maxSeconds}s. Timeouts send SIGTERM, then SIGKILL after ${config.killGraceSeconds}s, and report diagnostics; inspect partial side effects before retrying.`,
    promptGuidelines: [
      ...(definition.promptGuidelines ?? []),
      "On smart-timeout, use the output and diagnostic recommendation to decide whether to fix a stuck command or increase its timeout. Silence/output activity are not proof of a hang/progress. Do not blindly retry mutations or run endless servers/watch commands in foreground bash.",
    ],
    renderCall(args, theme, context) {
      if (context?.state && context?.executionStarted && context.state.startedAt === undefined) {
        context.state.startedAt = Date.now();
      }
      try {
        definition.renderCall?.(args, theme, context);
      } catch {}
      const formatted = formatBashCallWithTimeout(args, config, theme);
      const comp = context?.lastComponent;
      if (comp instanceof Text) {
        comp.setText(formatted);
        return comp;
      }
      return new Text(formatted, 0, 0);
    },
    async execute(id, params, signal, onUpdate, ctx) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", abort, { once: true });
      active.add(controller);
      let report: TimeoutReport | undefined;
      try {
        const settings = SettingsManager.create(ctx.cwd, getAgentDir());
        const shellPath = settings.getShellPath();
        const tool = createBashToolDefinition(ctx.cwd, {
          shellPath,
          commandPrefix: settings.getShellCommandPrefix(),
          operations: smartOperations(createLocalBashOperations({ shellPath }), config, value => { report = value; }),
        });
        const result = await tool.execute(id, params, controller.signal, onUpdate, ctx);
        const appliedTimeout = {
          wallSeconds: params.timeout ?? config.defaultSeconds,
          idleSeconds: params.timeout !== undefined ? undefined : config.idleSeconds,
          isExplicit: params.timeout !== undefined,
          stamp: formatTimeoutStamp(params.timeout, config),
        };
        const details = {
          ...result.details,
          appliedTimeout,
          ...(report ? { smartTimeout: report } : {}),
        };
        return { ...result, details };
      } finally {
        active.delete(controller);
        signal?.removeEventListener("abort", abort);
      }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    if (configError && ctx.hasUI) ctx.ui.notify(`Invalid ${path}; smart-timeout is using safe defaults. ${configError}`, "warning");
  });
  pi.on("session_shutdown", async () => {
    for (const controller of active) controller.abort();
    active.clear();
  });
  pi.registerCommand("smart-timeout", {
    description: "Show bash timeout limits and configuration path",
    handler: async (_args, ctx) => {
      const text = `Bash smart timeout: ${config.defaultSeconds}s total / ${config.idleSeconds}s silence; explicit timeout <= ${config.maxSeconds}s disables silence cutoff.\nConfig: ${path} (reload after editing).${configError ? `\nInvalid config; using defaults: ${configError}` : ""}`;
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else pi.sendMessage({ customType: "smart-timeout-config", content: text, display: true }, { triggerTurn: false });
    },
  });
}
