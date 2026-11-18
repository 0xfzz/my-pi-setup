/**
 * Browser module specifiers shared by the host, first-party entries and
 * external plugin bundles. Every file here is one generated shim or bundle.
 */
import { FILE_VIEWER_ASSET_URL, FILE_VIEWER_MODULE_BASE } from "./viewer.config.ts";

export type HostBundleName = "runtime" | "ui" | "icons" | "typebox-host" | "file-viewer";

export interface HostModuleEntry {
  readonly file: string;
  readonly bundle: HostBundleName;
  /** Static URL prefix; defaults to /host/ for core-owned bundles. */
  readonly base?: string;
  /** Omit when the bundle file itself is the module (e.g. @pi-web/host-ui). */
  readonly shim?: string;
  /** False when a first-party entry must bundle the package itself. */
  readonly firstPartyExternal?: boolean;
  /** True for modules served by the files plugin's own bundle. */
  readonly fileViewerInternal?: boolean;
}

/** One row per browser specifier exposed to first-party and external plugins. */
const hostModuleTable: Readonly<Record<string, HostModuleEntry>> = Object.freeze({
  react: {
    file: "react.js",
    bundle: "runtime",
    shim: 'export * from "./runtime.js";\nexport { ReactDefault as default } from "./runtime.js";\n',
  },
  "react/jsx-runtime": {
    file: "jsx-runtime.js",
    bundle: "runtime",
    shim: 'export { jsx, jsxs, JSXFragment as Fragment } from "./runtime.js";\n',
  },
  "react-dom": {
    file: "react-dom.js",
    bundle: "runtime",
    shim: 'export { createPortal, flushSync, preconnect, prefetchDNS, preinit, preinitModule, preload, preloadModule, requestFormReset, unstable_batchedUpdates, useFormState, useFormStatus, version, ReactDOM as default } from "./runtime.js";\n',
  },
  "react-dom/client": {
    file: "react-dom-client.js",
    bundle: "runtime",
    shim: 'export { createRoot, hydrateRoot } from "./runtime.js";\n',
  },
  "@phosphor-icons/react": {
    file: "phosphor.js",
    bundle: "icons",
    // First-party entries import named icons so the catalogue stays off the
    // initial path; external plugins still get the shared shim.
    firstPartyExternal: false,
    shim: 'export * from "./icons.js";\n',
  },
  "@file-viewer/react": {
    file: "file-viewer-react.js",
    bundle: "file-viewer",
    base: FILE_VIEWER_MODULE_BASE,
    fileViewerInternal: true,
    shim: 'export { FileViewer, FileViewerDefault as default, useFileViewerState } from "./file-viewer.js";\n',
  },
  "@file-viewer/core": {
    file: "file-viewer-core.js",
    bundle: "file-viewer",
    base: FILE_VIEWER_MODULE_BASE,
    fileViewerInternal: true,
    shim: 'export { setDefaultFileViewerAssetBaseUrl } from "./file-viewer.js";\nexport const FILE_VIEWER_ASSET_BASE_URL = ' + JSON.stringify(FILE_VIEWER_ASSET_URL) + ";\n",
  },
  "@file-viewer/preset-office": {
    file: "file-viewer-office.js",
    bundle: "file-viewer",
    base: FILE_VIEWER_MODULE_BASE,
    fileViewerInternal: true,
    shim: 'export { officePresetDefault as default } from "./file-viewer.js";\n',
  },
  "@pi-web/bridge": {
    file: "sdk.js",
    bundle: "runtime",
    shim: 'export * from "./runtime.js";\n',
  },
  "@pi-web/bridge/text": {
    file: "sdk-text.js",
    bundle: "runtime",
    shim: 'export { webUiText } from "./runtime.js";\n',
  },
  "@pi-web/host-ui": { file: "ui.js", bundle: "ui" },
  typebox: {
    file: "typebox.js",
    bundle: "typebox-host",
    shim: 'export * from "./typebox-host.js";\n',
  },
  "typebox/value": {
    file: "typebox-value.js",
    bundle: "typebox-host",
    shim: 'export * from "./typebox-host.js";\n',
  },
});

export const HOST_MODULE_TABLE = hostModuleTable;

export const HOST_MODULES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(hostModuleTable).map(([specifier, entry]) => [specifier, entry.file])),
);

export const HOST_SPECIFIERS: readonly string[] = Object.freeze(Object.keys(hostModuleTable));

/** Specifiers that first-party bundles leave to the import map. */
export const FIRST_PARTY_EXTERNALS: readonly string[] = Object.freeze(
  HOST_SPECIFIERS.filter((specifier) => hostModuleTable[specifier].firstPartyExternal !== false),
);

/** Per-entry externals, derived from the same rows as the import map. */
export const HOST_BUNDLE_EXTERNALS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  icons: [],
  "typebox-host": [],
  runtime: HOST_SPECIFIERS.filter((specifier) => hostModuleTable[specifier].bundle !== "runtime"),
  ui: FIRST_PARTY_EXTERNALS,
  "file-viewer": HOST_SPECIFIERS.filter(
    (specifier) => hostModuleTable[specifier].fileViewerInternal !== true,
  ),
});

const shims: Record<string, string> = {};
for (const [specifier, entry] of Object.entries(hostModuleTable)) {
  if (entry.shim !== undefined) shims[specifier] = entry.shim;
}
/** Tiny modules that re-export a shared bundle under a public specifier. */
export const HOST_SHIMS: Readonly<Record<string, string>> = Object.freeze(shims);

/** The browser import map, derived from the module table. */
export function hostImportMap(base = "/host/"): Record<string, string> {
  return Object.fromEntries(
    Object.entries(hostModuleTable).map(([specifier, entry]) => [specifier, `${entry.base ?? base}${entry.file}`]),
  );
}
