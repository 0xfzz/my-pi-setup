/**
 * Frozen Phase 0 shape of the trusted browser half (D1/D6). The kernel starts
 * enforcing it in Phase 4; keeping the contract here means the manifest and
 * the browser loader cannot invent different rules later.
 */
export const BROWSER_ENTRY = "main.browser";

type TrustTier = "declarative" | "trusted";

export interface BrowserHalfContract {
  /** Path of the browser module inside the plugin directory. */
  entry: string;
  /** Every browser half executes local code, so it is trusted-only. */
  trust: "trusted";
  /** Mount contract the browser loader calls, returning its cleanup. */
  mount: "mount(el, ctx)";
}

export function isAllowedBrowserEntry(trust: TrustTier, entry: unknown): boolean {
  return trust === "trusted"
    && typeof entry === "string"
    && entry.startsWith("./")
    && !entry.split("/").includes("..")
    && entry.length <= 256;
}
