/** Compatibility shim: the browser-half manifest contract lives in the standalone SDK. */
export {
  BROWSER_ENTRY,
  isAllowedBrowserEntry,
} from "@pi-web/bridge";
export type { BrowserHalfContract } from "@pi-web/bridge";
