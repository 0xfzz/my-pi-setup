/**
 * The web core command registry. pi's own built-ins are dispatched through
 * pi's runner or captured session context; the registry owns only wiring.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSessionToJsonl, serializeSessionBranch } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-export.js";
import {
  bugReportArchiveFileName,
  collectBugReportDiagnostics,
  collectBugReportMetadata,
  writeBugReportArchive,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/bug-report.js";
import { uploadBugReport } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/bug-report-upload.js";
import { readCrashLog } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/crash-log.js";
import { getRadiusGatewayUrl, RADIUS_PROVIDER_ID } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/radius.js";
import { getShareViewerUrl } from "../../node_modules/@earendil-works/pi-coding-agent/dist/config.js";
import { getAuthCredential } from "../../node_modules/@earendil-works/pi-coding-agent/dist/cli/auth-command.js";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT, type ActionRequestPayload } from "../../web/core/plugin-contracts/actions.ts";
import { publishWebView } from "../../web/core/plugin-contracts/publisher.ts";
import { type DialogWebView, type WebView } from "../../web/core/plugin-contracts/view.ts";
import { buildWebTree, type PiTreeNodeLike } from "../../lib/web-tree.ts";


export type WebCommandContext = ExtensionContext & {
  waitForIdle(): Promise<void>;
  newSession(): Promise<{ cancelled: boolean }>;
  fork(entryId: string, options: { position: string }): Promise<{ cancelled: boolean }>;
  navigateTree(targetId: string): Promise<{ cancelled: boolean }>;
  switchSession(sessionPath: string): Promise<void>;
  reload(): Promise<void>;
};

export interface WebCommandsDeps {
  pi: ExtensionAPI;
  notify: (message: string) => void;
  post: (event: unknown) => void;
}

export function createWebCommands({ pi, notify: ctxNotify, post }: WebCommandsDeps) {
  const bridgePoster = { post };
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

  return { WEB_CORE_COMMANDS, webCoreCommand, WEB_CORE_PLUGIN_ID };
}
