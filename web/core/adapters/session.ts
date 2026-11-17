/** Session adapters: protocol commands become calls on the session owner. */
import type { BridgeCommand } from "../server/bridge.ts";
import { bridgeError } from "../protocol/errors.ts";
import type { AdapterResult, ProtocolAdapter } from "./types.ts";

/** The slice of a session owner the protocol commands need. */
export interface SessionSurface {
  prompt(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void> | void;
  abort(): Promise<void> | void;
  setModel?(provider: string, id: string): Promise<boolean> | boolean;
  setThinkingLevel?(level: string): Promise<boolean> | boolean;
  webCommand?(name: string, args: string): Promise<void> | void;
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

export function createSessionAdapters(owner: SessionSurface): Record<string, ProtocolAdapter> {
  return {
    "session.prompt": (_ctx, params) => resultOf("prompt", () => owner.prompt(requireText(params, "text"))),
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
  };
}
