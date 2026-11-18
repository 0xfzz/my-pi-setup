/** Session adapters: protocol commands become calls on the session owner. */
import type { BridgeCommand } from "../server/bridge.ts";
import { parseSessionCommand } from "../server/sessions.ts";
import { bridgeError } from "../protocol/errors.ts";
import type { AdapterResult, ProtocolAdapter } from "./types.ts";
import { createDirectoryAdapters, type DirectorySurface } from "./directory.ts";

/** The slice of a session owner the protocol commands need. */
export interface SessionSurface {
  prompt(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void> | void;
  abort(): Promise<void> | void;
  setModel?(provider: string, id: string): Promise<boolean> | boolean;
  setThinkingLevel?(level: string): Promise<boolean> | boolean;
  webCommand?(name: string, args: string): Promise<void> | void;
  /** Read-only surfaces backed by the live session or its persisted stores. */
  get?(): unknown;
  branch?(): Promise<unknown> | unknown;
  models?(): Promise<unknown> | unknown;
  tree?(): unknown;
  commands?(): Promise<unknown> | unknown;
  history?(params: unknown): Promise<unknown> | unknown;
  toolResult?(toolCallId: string): Promise<unknown> | unknown;
  snapshot?(): unknown;
  resync?(cursor?: string): Promise<unknown> | unknown;
}

/** Session-attach owners execute commands by forwarding them to the TUI. */
export function bridgeCommandSurface(send: (command: BridgeCommand) => void): SessionSurface {
  return {
    prompt: (text, images) => send({ type: "prompt", message: text, ...(images === undefined ? {} : { images }) }),
    abort: () => send({ type: "abort" }),
    setModel: (provider, id) => { send({ type: "set_model", provider, id }); return true; },
    setThinkingLevel: (level) => { send({ type: "set_thinking", level }); return true; },
    webCommand: (name, args) => send({ type: "web_command", name, args }),
  };
}

function unavailable(operation: string): AdapterResult<never> {
  return {
    ok: false,
    error: bridgeError("ADAPTER_UNAVAILABLE", `session owner cannot ${operation}`),
  };
}

function requireText(params: unknown, field: string): string {
  const value = (params as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

async function resultOf(
  operation: string,
  run: () => Promise<boolean | void> | boolean | void,
): Promise<AdapterResult<{ ok: true }>> {
  try {
    const applied = await run();
    return applied === false ? unavailable(operation) : { ok: true, value: { ok: true } };
  } catch (error) {
    return {
      ok: false,
      error: bridgeError("ADAPTER_UNAVAILABLE", `session owner cannot ${operation}: ${error instanceof Error ? error.message : "unknown error"}`),
    };
  }
}

/** Reuse the server's image bounds; a bad attachment is a named failure, never a throw. */
function promptRequest(params: unknown): { text: string; images?: Array<{ data: string; mimeType: string }> } {
  const text = requireText(params, "text");
  const images = (params as Record<string, unknown> | null)?.images;
  const parsed = parseSessionCommand({
    type: "prompt",
    message: text,
    ...(images === undefined ? {} : { images }),
  });
  if ("error" in parsed || parsed.type !== "prompt") {
    throw new Error("error" in parsed ? parsed.error : "prompt validation failed");
  }
  return { text: parsed.message, images: parsed.images };
}

async function readSurface(operation: string, read: (() => Promise<unknown> | unknown) | undefined): Promise<AdapterResult<unknown>> {
  if (read === undefined) return unavailable(operation);
  try {
    const value = await read();
    return value === undefined ? unavailable(operation) : { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      error: bridgeError("ADAPTER_UNAVAILABLE", `session owner cannot ${operation}: ${error instanceof Error ? error.message : "unknown error"}`),
    };
  }
}

async function bestEffortRead(operation: string, read: (() => Promise<unknown> | unknown) | undefined): Promise<unknown> {
  const result = await readSurface(operation, read);
  return result.ok ? result.value : undefined;
}

export function createSessionAdapters(
  owner: SessionSurface,
  directory?: DirectorySurface,
): Record<string, ProtocolAdapter> {
  const directoryAdapters = directory === undefined ? {} : createDirectoryAdapters(directory);
  return {
    ...directoryAdapters,
    "session.prompt": (_ctx, params) => resultOf("prompt", () => {
      const request = promptRequest(params);
      return owner.prompt(request.text, request.images);
    }),
    "session.abort": () => resultOf("abort", () => owner.abort()),
    "session.set-model": (_ctx, params) => resultOf("set model", () => {
      const provider = requireText(params, "provider");
      const id = requireText(params, "id");
      return owner.setModel === undefined ? false : owner.setModel(provider, id);
    }),
    "session.set-thinking": (_ctx, params) => resultOf("set thinking level", () => {
      const level = requireText(params, "level");
      return owner.setThinkingLevel === undefined ? false : owner.setThinkingLevel(level);
    }),
    "web-command.dispatch": (_ctx, params) => resultOf("dispatch web command", () => {
      const name = requireText(params, "name");
      const args = (params as Record<string, unknown>).args;
      return owner.webCommand === undefined ? false : owner.webCommand(name, typeof args === "string" ? args : "");
    }),
    "extension.web-command.dispatch": (_ctx, params) => resultOf("dispatch extension web command", () => {
      const name = requireText(params, "name");
      const args = (params as Record<string, unknown>).args;
      return owner.webCommand === undefined ? false : owner.webCommand(name, typeof args === "string" ? args : "");
    }),
    "session.get": () => readSurface("read session", owner.get),
    "session.boot": async () => {
      const [state, branch, models, commands] = await Promise.all([
        bestEffortRead("read session", owner.get),
        bestEffortRead("read branch", owner.branch),
        bestEffortRead("read models", owner.models),
        bestEffortRead("read commands", owner.commands),
      ]);
      return {
        ok: true,
        value: {
          ...(state === undefined ? {} : { session: state }),
          ...(branch === undefined ? {} : { branch }),
          ...(models === undefined ? {} : { models }),
          ...(commands === undefined ? {} : { commands }),
        },
      };
    },
    "session.branch": () => readSurface("read branch", owner.branch),
    "session.models": () => readSurface("read models", owner.models),
    "session.tree": () => readSurface("read tree", owner.tree),
    "session.commands": () => readSurface("read commands", owner.commands),
    "session.history": (_ctx, params) => readSurface("read history", () => owner.history?.(params)),
    "session.tool-result": (_ctx, params) => readSurface("read tool result", () => owner.toolResult?.(requireText(params, "toolCallId"))),
    "ui.snapshot": () => Promise.resolve({ ok: true, value: owner.snapshot?.() ?? {} }),
    "session.resync": (_ctx, params) => {
      const cursor = (params as Record<string, unknown> | null)?.cursor;
      return readSurface("resync session", () => owner.resync?.(typeof cursor === "string" ? cursor : undefined));
    },
  };
}
