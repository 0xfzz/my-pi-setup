/**
 * Frozen Phase 4 rules for trusted browser halves. Pure decisions only: the
 * loader mounts code, the kernel audits, both use these rules unchanged.
 */
import { isProtectedPoint } from "../plugin-contracts/kernel/catalog.ts";
import { BRIDGE_MESSAGE_EVENT } from "./publisher.ts";

export const BROWSER_MOUNT_CONTRACT = "mount(el, ctx): () => void";
export const BROWSER_MAX_BREAKER = 3;

export interface BrowserGrant {
  readonly id: string;
  readonly version: string;
  /** Where the browser module came from; shown in the confirmation prompt. */
  readonly sourcePath: string;
  /** SHA-256 of the browser module contents the operator confirmed. */
  readonly hash: string;
  readonly capabilities: readonly string[];
  readonly confirmedAt: number;
}

export type BrowserGrantDecision =
  | { readonly kind: "load"; readonly grant: BrowserGrant }
  | { readonly kind: "confirm" }
  | { readonly kind: "revoke"; readonly reason: string };

/**
 * A browser half runs local code: no grant means no load, and a changed hash
 * revokes the old grant until the operator confirms the new contents.
 */
export function browserGrantDecision(options: {
  readonly id: string;
  readonly version: string;
  readonly hash: string;
  readonly sourcePath: string;
  readonly trust: "declarative" | "trusted";
  readonly grant: BrowserGrant | undefined;
  readonly now: number;
}): BrowserGrantDecision {
  if (options.trust !== "trusted") return { kind: "revoke", reason: "a browser half requires trust 'trusted'" };
  if (options.grant === undefined) return { kind: "confirm" };
  if (options.grant.hash !== options.hash) return { kind: "revoke", reason: "browser module hash changed" };
  if (options.grant.version !== options.version) return { kind: "revoke", reason: "browser module version changed" };
  return {
    kind: "load",
    grant: { ...options.grant, capabilities: [...options.grant.capabilities] },
  };
}

export function confirmBrowserGrant(options: {
  id: string;
  version: string;
  hash: string;
  sourcePath: string;
  capabilities: readonly string[];
  now: number;
}): BrowserGrant {
  return {
    id: options.id,
    version: options.version,
    sourcePath: options.sourcePath,
    hash: options.hash,
    capabilities: [...options.capabilities],
    confirmedAt: options.now,
  };
}

/** Protected core points accept observers, never replacements. */
export function browserRegistrationRefusal(point: string): string | undefined {
  return isProtectedPoint(point)
    ? `extension point "${point}" is protected core and cannot be replaced`
    : undefined;
}

/** One render failure restores the built-in in the same frame and counts toward the breaker. */
export function browserFailureDecision(failures: number, limit = BROWSER_MAX_BREAKER): "restore" | "quarantine" {
  return failures + 1 >= limit ? "quarantine" : "restore";
}

export function browserAllowedInSafeMode(safeMode: boolean, corePlugin: boolean): boolean {
  return !safeMode || corePlugin;
}

export const BROWSER_LOAD_EVENT = BRIDGE_MESSAGE_EVENT;

/** The extension points a trusted browser half may contribute to. */
export const BROWSER_EXTENSION_POINTS = [
  "ui.region.replace", "ui.region.wrap", "ui.component.replace", "ui.component.wrap",
  "ui.page", "ui.route", "commands", "keys", "themes", "tokens", "protocol.hooks",
] as const;

export function isBrowserExtensionPoint(point: string): boolean {
  return (BROWSER_EXTENSION_POINTS as readonly string[]).includes(point);
}

/** One audit line names everything the operator confirmed. */
export function browserGrantAuditDetail(grant: BrowserGrant): string {
  return `${grant.id}@${grant.version} ${grant.sourcePath} sha256 ${grant.hash} capabilities ${grant.capabilities.join(",") || "none"}`;
}
