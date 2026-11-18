/**
 * Core-side browser rules: the pure grant and mount decisions come from the
 * standalone SDK; only protected-point policy stays with the kernel.
 */
import { isProtectedPoint } from "../plugin-contracts/kernel/catalog.ts";
import { browserAllowedInSafeMode } from "@pi/web-bridge";

export {
  BROWSER_LOAD_EVENT,
  BROWSER_MAX_BREAKER,
  BROWSER_MOUNT_CONTRACT,
  browserAllowedInSafeMode,
  browserFailureDecision,
  browserGrantAuditDetail,
  browserGrantDecision,
  browserGrantPromptText,
  browserGrantUpdate,
  confirmBrowserGrant,
} from "@pi/web-bridge";
export type {
  BrowserGrant,
  BrowserGrantAuditEntry,
  BrowserGrantDecision,
} from "@pi/web-bridge";

/** Protected core points accept observers, never replacements. */
export function browserRegistrationRefusal(point: string): string | undefined {
  return isProtectedPoint(point)
    ? `extension point "${point}" is protected core and cannot be replaced`
    : undefined;
}

/** The real registration path refuses protected points and points nobody hosts. */
export function browserExtensionPointRefusal(point: string): string | undefined {
  return browserRegistrationRefusal(point)
    ?? (isBrowserExtensionPoint(point) ? undefined : `unknown extension point "${point}"`);
}

/** Lifecycle state the kernel owns: any of these restores the built-in. */
export function browserMountRefusal(registration: {
  readonly point?: string;
  readonly safeMode?: boolean;
  readonly corePlugin?: boolean;
  readonly disabled?: boolean;
  readonly quarantined?: boolean;
  readonly failedLoad?: boolean;
}): string | undefined {
  const pointRefusal = registration.point === undefined ? undefined : browserRegistrationRefusal(registration.point);
  if (pointRefusal !== undefined) return pointRefusal;
  if (registration.disabled === true) return "plugin is disabled";
  if (registration.quarantined === true) return "plugin is quarantined after render failures";
  if (registration.failedLoad === true) return "browser half failed to load";
  if (!browserAllowedInSafeMode(registration.safeMode === true, registration.corePlugin === true)) {
    return "safe mode loads Pi Web Core only";
  }
  return undefined;
}

/** The extension points a trusted browser half may contribute to. */
export const BROWSER_EXTENSION_POINTS = [
  "ui.region.replace", "ui.region.wrap", "ui.component.replace", "ui.component.wrap",
  "ui.page", "ui.route", "commands", "keys", "themes", "tokens", "protocol.hooks",
] as const;

export function isBrowserExtensionPoint(point: string): boolean {
  return (BROWSER_EXTENSION_POINTS as readonly string[]).includes(point);
}
