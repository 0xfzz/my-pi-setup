/**
 * Bridge command dispatch. The attached TUI's commands are translated into
 * calls on this session; all wire names and notification text stay unchanged.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT, validateActionValues } from "../../web/core/plugin-contracts/actions.ts";
import { WEB_PLUGIN_WEB_COMMAND_EVENT } from "../../web/core/plugin-contracts/web-commands.ts";
import { WEB_PLUGIN_UI_SYNC_EVENT } from "../../web/core/plugin-contracts/ui-event-models.ts";
import { findModelRef, type ModelRef } from "../../lib/model-ref.ts";
import { sseFrameData, takeSseFrames } from "../../lib/web-sse.ts";
import type { WebCommandContext } from "./commands.ts";

interface BridgeBodyReader {
  read(): Promise<{ done?: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}
interface BridgeBody { getReader(): BridgeBodyReader; }

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

function actionValuesOf(raw: unknown): Record<string, string> | undefined {
  const validated = validateActionValues(raw);
  if (!validated.ok || validated.values === undefined) return undefined;
  return Object.keys(validated.values).length > 0 ? validated.values : undefined;
}

export interface BridgeDispatchDeps {
  pi: ExtensionAPI;
  notify: (message: string) => void;
  getLastCtx: () => ExtensionContext | null;
  getBridgeSessionId: () => string | null;
  getWebCoreCommand: (name: string) => { dispatch: "runner" | "direct"; handler: (args: string, ctx: WebCommandContext) => void | Promise<void> } | undefined;
  contributedCommands: Map<string, { name: string; description?: string }>;
  pickableModelRefs: (ctx: ExtensionContext) => ModelRef[];
  applyModelRef: (ctx: ExtensionContext, ref: ModelRef) => Promise<string>;
  postSessionState: (ctx: ExtensionContext) => void;
  postBridgeState: (sessionId: string, state: Record<string, unknown>) => Promise<void>;
  bridgeStateOf: (ctx: ExtensionContext) => Record<string, unknown>;
}

export function createBridgeDispatch(deps: BridgeDispatchDeps) {
  const {
    pi,
    notify: ctxNotify,
    getLastCtx,
    getBridgeSessionId,
    getWebCoreCommand,
    contributedCommands,
    pickableModelRefs,
    applyModelRef,
    postSessionState,
    postBridgeState,
    bridgeStateOf,
  } = deps;
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
        confirm?: unknown;
        values?: unknown;
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
        getLastCtx()?.abort();
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
      const ctx = getLastCtx();
      if (ctx === null) return;
      const ref = findModelRef(pickableModelRefs(ctx), `${command.provider}/${command.id}`);
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
        const activeCtx = getLastCtx();
        if (activeCtx !== null) postSessionState(activeCtx);
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
      // captured session context. A command another extension registered
      // (web/core/plugin-contracts/web-commands.ts) is always direct.
      const args = typeof command.args === "string" ? command.args : "";
      const entry = getWebCoreCommand(command.name);
      if (entry === undefined) {
        // Not one of ours: hand it back to whichever extension announced it.
        // The contributor runs it with the context it captured itself.
        if (!contributedCommands.has(command.name)) {
          ctxNotify(`unknown web command: ${command.name}`);
          return;
        }
        pi.events?.emit(WEB_PLUGIN_WEB_COMMAND_EVENT, { name: command.name, args });
        return;
      }
      if (entry.dispatch === "runner") {
        // pi.sendUserMessage returns void (fire-and-forget); its errors
        // surface through the runner's own error reporting.
        pi.sendUserMessage(`/web-${command.name}${args.trim() !== "" ? ` ${args.trim()}` : ""}`, {
          expandPromptTemplates: true,
        });
        return;
      }
      const ctx = getLastCtx() as WebCommandContext | null;
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
      // like in-process ones. An instant action's typed dialog answer
      // (confirm) and its form answers (values) travel with it: a dialog row
      // carries its target in `values` (`{ providerId }`, `{ modelId }`, a
      // form's fields), so dropping them left the extension with a click it
      // could not attribute and no view to publish.
      const values = actionValuesOf(command.values);
      pi.events?.emit(WEB_PLUGIN_ACTION_REQUEST_EVENT, {
        requestId: typeof command.requestId === "string" ? command.requestId : "",
        sessionId,
        pluginId: command.pluginId,
        actionId: command.actionId,
        ...(typeof command.confirm === "string" && command.confirm !== "" ? { confirm: command.confirm } : {}),
        ...(values !== undefined ? { values } : {}),
      });
      return;
    }
    if (command.type === "ui_sync") {
      // The web attached after this session already published its views:
      // re-emit the current UI values (publisher remembers the last value per
      // plugin and re-publishes them on this event).
      pi.events?.emit(WEB_PLUGIN_UI_SYNC_EVENT, {});
      // The state snapshot is a value too: the server caches it for the
      // browser's first render, and a consumer attaching late must see the
      // current reading rather than whatever was cached when the bridge
      // opened.
      const sessionId = getBridgeSessionId();
      const activeCtx = getLastCtx();
      if (sessionId !== null && activeCtx !== null) {
        void postBridgeState(sessionId, bridgeStateOf(activeCtx));
      }
      return;
    }
  };

  return { consumeBridgeCommands };
}
