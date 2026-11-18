/** Wire contract for externally built, trusted browser halves. */
import type { BrowserHalfSource } from "../plugin-contracts/kernel/browser-halves.ts";

export type { BrowserHalfSource };

export interface BrowserHalfMetadata extends Omit<BrowserHalfSource, "dir"> {
  readonly url: string;
  readonly hash: string;
}

export const BROWSER_HALVES_API = "/api/browser-halves";
export const BROWSER_HALF_MAX_BYTES = 2 * 1024 * 1024;

export function browserHalfAssetUrl(id: string): string {
  return `${BROWSER_HALVES_API}/${encodeURIComponent(id)}/main.js`;
}

function strings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
  return value;
}

/** Treat every server field as untrusted before it reaches a browser import. */
export function isBrowserHalfMetadata(value: unknown): value is BrowserHalfMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string"
    && typeof row.version === "string"
    && typeof row.source === "string"
    && typeof row.sourcePath === "string"
    && typeof row.trust === "string"
    && typeof row.url === "string"
    && typeof row.hash === "string"
    && strings(row.capabilities) !== undefined;
}
