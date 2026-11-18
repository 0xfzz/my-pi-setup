/**
 * Trusted browser-half loader. The host owns mounting and fallback; a plugin
 * exports only `mount(el, ctx)` and gets a context with no core internals.
 */
import type { ProtocolClient } from "../protocol-client.ts";
import {
  BROWSER_MAX_BREAKER,
  browserFailureDecision,
  browserGrantDecision,
  browserMountRefusal,
  type BrowserGrant,
} from "../../protocol/browser-runtime.ts";
import type { BrowserContributionRegistry } from "./browser-contributions.ts";

export interface WebPluginContext {
  readonly protocol: ProtocolClient;
  readonly host: Readonly<Record<string, unknown>>;
  readonly theme: Readonly<Record<string, string>>;
  readonly logger: { info(message: string): void; warn(message: string): void };
  readonly dom: {
    text(value: string): Text;
    clear(element: HTMLElement): void;
  };
  /** Extension-point registration for this half; protected points are refused. */
  readonly register: (point: string, key: string, value: unknown) => boolean;
  readonly contributions: BrowserContributionRegistry;
}

export interface BrowserModule {
  mount(el: HTMLElement, ctx: WebPluginContext): () => void;
}

export interface BrowserRegistration {
  readonly id: string;
  readonly version: string;
  readonly hash: string;
  readonly sourcePath: string;
  readonly trust: "declarative" | "trusted";
  readonly now: number;
  readonly module: BrowserModule;
  readonly grant: BrowserGrant | undefined;
  readonly safeMode?: boolean;
  readonly corePlugin?: boolean;
  readonly point?: string;
  readonly disabled?: boolean;
  readonly quarantined?: boolean;
  readonly failedLoad?: boolean;
}

export type BrowserLoadResult =
  | { ok: true; unmount: () => void }
  | { ok: false; reason: string; kind: "confirm" | "revoke" | "refusal" };

export interface BrowserMountHost {
  /** Render the built-in region; called when a plugin render fails. */
  restoreBuiltIn(): void;
  /** Increment the per-contribution breaker. */
  recordFailure(id: string): void;
}

/** The loader never executes a browser half without a matching grant. */
export function loadBrowserHalf(registration: BrowserRegistration): BrowserLoadResult {
  const refusal = browserMountRefusal(registration);
  if (refusal !== undefined) return { ok: false, reason: refusal, kind: "refusal" };
  const decision = browserGrantDecision(registration);
  if (decision.kind !== "load") {
    return { ok: false, reason: decision.kind === "confirm" ? "operator confirmation required" : decision.reason, kind: decision.kind };
  }
  let cleanup: (() => void) | undefined;
  return { ok: true, unmount: () => { cleanup?.(); cleanup = undefined; } };
}

/** Mount inside an error boundary: a throw restores the built-in same frame. */
export function mountBrowserHalf(
  registration: BrowserRegistration,
  ctx: WebPluginContext,
  el: HTMLElement,
  host: BrowserMountHost,
  failures = 0,
): BrowserLoadResult {
  const loaded = loadBrowserHalf(registration);
  if (!loaded.ok) {
    host.restoreBuiltIn();
    return loaded;
  }
  try {
    const cleanup = registration.module.mount(el, ctx);
    if (typeof cleanup !== "function") throw new Error("mount must return a cleanup function");
    return { ok: true, unmount: () => { try { cleanup(); } finally { loaded.unmount(); } } };
  } catch (error) {
    host.restoreBuiltIn();
    host.recordFailure(registration.id);
    const nextFailures = failures + 1;
    ctx.logger.warn(`plugin ${registration.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      ok: false,
      reason: nextFailures >= BROWSER_MAX_BREAKER
        ? `plugin ${registration.id} quarantined after ${nextFailures} render failures`
        : "built-in region restored",
      kind: "revoke",
    };
  }
}

/** Exposed for tests and for the plugin manager's breaker display. */
export function failureDecision(failures: number): "restore" | "quarantine" {
  return browserFailureDecision(failures);
}
