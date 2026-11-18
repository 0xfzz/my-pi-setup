/** Structural access to the registry owned by the kernel host. */
import type { PluginMessageRegistry } from "@pi/web-bridge";

import { getPluginHost } from "./plugin-host.ts";

function isRegistry(value: unknown): value is PluginMessageRegistry {
  if (value === null || typeof value !== "object") return false;
  const methods = ["register", "lookup", "capabilities", "names", "validatePayload"];
  return methods.every((name) => typeof Reflect.get(value, name) === "function");
}

/** The host interface is structural so this lane does not depend on Phase 2 file edits. */
export function pluginMessageRegistry(): PluginMessageRegistry | undefined {
  const host: unknown = getPluginHost();
  if (host === null || typeof host !== "object") return undefined;
  const candidate: unknown = Reflect.get(host, "messages");
  return isRegistry(candidate) ? candidate : undefined;
}

export function pluginMessageNames(): readonly string[] {
  return pluginMessageRegistry()?.names().map((entry) => entry.name) ?? [];
}

export function pluginMessageCapabilities(): readonly string[] {
  return pluginMessageRegistry()?.capabilities() ?? [];
}
