/**
 * Runtime registry for the extension points a trusted browser half registers
 * into. The point vocabulary and the protected-core refusal are pure protocol
 * rules; this module only stores and announces accepted registrations.
 */
import { browserExtensionPointRefusal } from "../../protocol/browser-runtime.ts";

export interface BrowserContribution {
  readonly point: string;
  readonly key: string;
  readonly value: unknown;
}

export interface RegisteredBrowserContribution extends BrowserContribution {
  readonly pluginId: string;
}

export type RegistrationResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface BrowserContributionRegistry {
  register(pluginId: string, contribution: BrowserContribution): RegistrationResult;
  unregisterPlugin(pluginId: string): number;
  list(point?: string): readonly RegisteredBrowserContribution[];
  subscribe(listener: () => void): () => void;
}

export function createBrowserContributionRegistry(): BrowserContributionRegistry {
  const entries: RegisteredBrowserContribution[] = [];
  const listeners = new Set<() => void>();
  const announce = (): void => { for (const listener of listeners) listener(); };

  return {
    register(pluginId, contribution) {
      const refusal = browserExtensionPointRefusal(contribution.point);
      if (refusal !== undefined) return { ok: false, reason: refusal };
      const index = entries.findIndex((entry) =>
        entry.pluginId === pluginId && entry.point === contribution.point && entry.key === contribution.key);
      const next = { pluginId, ...contribution };
      if (index === -1) entries.push(next);
      else entries[index] = next;
      announce();
      return { ok: true };
    },
    unregisterPlugin(pluginId) {
      const before = entries.length;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index]?.pluginId === pluginId) entries.splice(index, 1);
      }
      const removed = before - entries.length;
      if (removed > 0) announce();
      return removed;
    },
    list(point) {
      return entries.filter((entry) => point === undefined || entry.point === point);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
