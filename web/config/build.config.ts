/**
 * Build entries and cold-path ceilings. Sources name the plugin or core owner;
 * output directories are static paths the server already serves.
 */
import type { HostBundleName } from "./host-modules.config.ts";
import { FILE_VIEWER_BUNDLE_OUTDIR } from "./viewer.config.ts";

export const HOST_BUNDLES: Readonly<
  Record<HostBundleName, { source: string; outdir: string; external: string }>
> = Object.freeze({
  runtime: { source: "core/client/host/runtime.ts", outdir: "host", external: "runtime" },
  ui: { source: "core/client/host/ui.ts", outdir: "host", external: "ui" },
  icons: { source: "core/client/host/icons.ts", outdir: "host", external: "icons" },
  "typebox-host": { source: "core/client/host/typebox.ts", outdir: "host", external: "typebox-host" },
  // The viewer source belongs to the files plugin; core only serves its output.
  "file-viewer": {
    source: "plugins/files/vendor/file-viewer.ts",
    outdir: FILE_VIEWER_BUNDLE_OUTDIR,
    external: "file-viewer",
  },
});

/** Build-time ceilings for JavaScript fetched on a cold page load. */
export const INITIAL_BUNDLE_BUDGETS: Readonly<Record<string, number>> = Object.freeze({
  "app.js": 850_000,
  "runtime.js": 500_000,
  "ui.js": 650_000,
});
