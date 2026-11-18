/** Directory adapters: session-less messages delegate to the server's own functions. */
import { bridgeError } from "../protocol/errors.ts";
import type { AdapterResult, ProtocolAdapter } from "./types.ts";

export interface DirectorySurface {
  list(params: { query?: string }): Promise<unknown> | unknown;
  create(params: { cwd?: string }): Promise<unknown> | unknown;
  get(params: { id?: string }): Promise<unknown> | unknown;
  remove(params: { id?: string }): Promise<unknown> | unknown;
  rename(params: { id?: string; name?: string }): Promise<unknown> | unknown;
}

function invalid(operation: string, reason: string): AdapterResult<never> {
  return { ok: false, error: bridgeError("VALIDATION_FAILED", `${operation}: ${reason}`) };
}

function text(params: unknown, field: string): string | undefined {
  const value = (params as Record<string, unknown> | null)?.[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function call(
  operation: string,
  run: () => Promise<unknown> | unknown,
): Promise<AdapterResult<unknown>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return {
      ok: false,
      error: bridgeError("INTERNAL", `${operation} failed: ${error instanceof Error ? error.message : "unknown error"}`),
    };
  }
}

export function createDirectoryAdapters(surface: DirectorySurface): Record<string, ProtocolAdapter> {
  return {
    "session.list": (_ctx, params) => call("session.list", () => surface.list({ query: text(params, "query") })),
    "session.search": (_ctx, params) => {
      const query = text(params, "query");
      return query === undefined
        ? Promise.resolve(invalid("session.search", "query must be a non-empty string"))
        : call("session.search", () => surface.list({ query }));
    },
    "session.create": (_ctx, params) => call("session.create", () => surface.create({ cwd: text(params, "cwd") })),
    "session.get": (_ctx, params) => {
      const id = text(params, "id");
      return id === undefined
        ? Promise.resolve(invalid("session.get", "id must be a non-empty string"))
        : call("session.get", () => surface.get({ id }));
    },
    "session.delete": (_ctx, params) => {
      const id = text(params, "id");
      return id === undefined
        ? Promise.resolve(invalid("session.delete", "id must be a non-empty string"))
        : call("session.delete", () => surface.remove({ id }));
    },
    "session.rename": (_ctx, params) => {
      const id = text(params, "id");
      const name = text(params, "name");
      return id === undefined || name === undefined
        ? Promise.resolve(invalid("session.rename", "id and name must be non-empty strings"))
        : call("session.rename", () => surface.rename({ id, name }));
    },
  };
}
