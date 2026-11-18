/**
 * The single registration file for the web host.
 *
 * Add a plugin here with its descriptor import; add a shared browser module
 * here with its specifier, bundle and optional shim. Build scripts and the
 * composition root read this file — none of them own a registration list.
 *
 * Core stays baseline-only. The files plugin owns the document-viewer vendor
 * entry and its asset list; core only serves the generated static assets.
 */
import { artifactsPlugin } from "./plugins/artifacts/descriptor.ts";
import { askUserPlugin } from "./plugins/ask-user/descriptor.ts";
import { autoTitlePlugin } from "./plugins/auto-title/descriptor.ts";
import { bubblySpinnerPlugin } from "./plugins/bubbly-spinner/descriptor.ts";
import { cacheStatsPlugin } from "./plugins/cache-stats/descriptor.ts";
import { exampleOverridePlugin } from "./plugins/example-override/descriptor.ts";
import { mcpManagerPlugin } from "./plugins/mcp-manager/descriptor.ts";
import { modesPlugin } from "./plugins/modes/descriptor.ts";
import { pluginManagerPlugin } from "./plugins/plugin-manager/descriptor.ts";
import { providersPlugin } from "./plugins/providers/descriptor.ts";
import { routerEditorPlugin, routerPlugin } from "./plugins/router/descriptor.ts";
import { subagentCheckpointsPlugin } from "./plugins/subagent-checkpoints/descriptor.ts";
import { subagentGraphPlugin } from "./plugins/subagent-graph/descriptor.ts";
import { todoPlugin } from "./plugins/todo/descriptor.ts";
import { webBridgePlugin } from "./plugins/web-bridge/descriptor.ts";
import type { WebPluginDescriptor } from "./core/plugin-contracts/descriptor.ts";

const FILE_VIEWER_BUNDLE_OUTDIR = "plugins/files";
const FILE_VIEWER_MODULE_BASE = `/${FILE_VIEWER_BUNDLE_OUTDIR}/`;
const FILE_VIEWER_ASSET_DIR = "file-viewer";
const FILE_VIEWER_ASSET_OUTDIR = `${FILE_VIEWER_BUNDLE_OUTDIR}/${FILE_VIEWER_ASSET_DIR}`;
const FILE_VIEWER_ASSET_URL = `${FILE_VIEWER_MODULE_BASE}${FILE_VIEWER_ASSET_DIR}/`;

/** Every first-party descriptor the composition root registers. */
export const WEB_PLUGINS: readonly WebPluginDescriptor[] = Object.freeze([
  cacheStatsPlugin,
  todoPlugin,
  artifactsPlugin,
  subagentCheckpointsPlugin,
  subagentGraphPlugin,
  bubblySpinnerPlugin,
  modesPlugin,
  autoTitlePlugin,
  askUserPlugin,
  mcpManagerPlugin,
  pluginManagerPlugin,
  providersPlugin,
  routerPlugin,
  routerEditorPlugin,
  exampleOverridePlugin,
  webBridgePlugin,
]);

/** Pi extensions with no web descriptor, and the reason they are absent. */
export const WEB_PLUGIN_OPT_OUT: Readonly<Record<string, string>> = Object.freeze({
  agent:
    "Parent delegation engine, tool dispatch, and child lifecycle tracking; no persistent web view",
  "antigravity-accounts":
    "Multi-account provider registration for Google accounts; credential management without a web view",
  "cache-breakpoints":
    "Prompt-cache breakpoint injection on volatile message tails; invisible background middleware",
  "cache-trace":
    "Opt-in diagnostic logging cache prefix sharing to JSONL; no persistent view",
  "clipboard-paste":
    "Terminal clipboard paste handler across Linux protocols; input-only tool",
  "dynamic-prompt":
    "Registry-driven system prompt builder; background prompt middleware",
  "image-thumbnails":
    "Downscaled image previews for terminal rendering; TUI-only media optimization",
  "prompt-ui":
    "Interactive popup prompt selector and editor; TUI-only dialog",
  sidebar:
    "TUI-only sidebar layout, chrome, aquarium animation, and split rendering",
  "smart-timeout":
    "Bash execution timeout and idle process watchdog; background execution policy",
  "stream-recovery":
    "Interrupted tool-generation checkpoints and suffix recovery; background middleware with command/tool output, no dedicated web view",
  "web-read":
    "Headless browser page reader tool for web retrieval; tool-only execution",
  web:
    "Web UI process management and single-instance server launcher; control command with no persistent view",
});

type HostBundleName = "runtime" | "ui" | "icons" | "typebox-host" | "file-viewer";

interface HostModuleEntry {
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

/** Build entries: source owner and static output directory for each bundle. */
export const HOST_BUNDLES: Readonly<
  Record<string, { source: string; outdir: string; external: string }>
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

/** Build-time ceilings for JavaScript fetched on a cold page load. */
export const INITIAL_BUNDLE_BUDGETS: Readonly<Record<string, number>> = Object.freeze({
  "app.js": 850_000,
  "runtime.js": 500_000,
  "ui.js": 650_000,
});

/** Viewer files once emitted by core; the build removes stale copies. */
export const LEGACY_CORE_HOST_FILES: readonly string[] = Object.freeze([
  "file-viewer.js",
  "file-viewer-react.js",
  "file-viewer-core.js",
  "file-viewer-office.js",
]);

/** Viewer assets are registered by the files plugin, never by core. */
export const FILE_VIEWER_ASSETS = Object.freeze({
  baseUrl: FILE_VIEWER_ASSET_URL,
  outdir: FILE_VIEWER_ASSET_OUTDIR,
  renderers: Object.freeze([
    "pdf",
    "office-word-openxml",
    "spreadsheet-openxml",
    "office-presentation",
    "office-presentation-binary",
  ]),
});

/**
 * E2E fixture registrations. The session and view factories live with the
 * fixture plugin; the ids and which surface each one publishes live here.
 */
export const WEB_TEST_FIXTURES = Object.freeze({
  activationEnv: "PI_WEB_TEST_PLUGIN_VIEWS",
  filesRootEnv: "PI_WEB_TEST_FILES_ROOT",
  sessionId: "__test_session__",
  sessionTitle: "Plan review",
  fallbackActionPlugin: "subagent-graph",
  defaultActionFactory: "monitorGraph",
  actionFactories: Object.freeze<Record<string, string>>({
    router: "routingGraph",
    "subagent-graph": "monitorGraph",
  }),
  views: Object.freeze([
    { pluginId: "cache-stats", factory: "cacheStats" },
    { pluginId: "todo", factory: "todo" },
    { pluginId: "artifacts", factory: "artifacts" },
    { pluginId: "subagent-checkpoints", factory: "checkpoints" },
    { pluginId: "subagent-graph", factory: "monitorGraph" },
    { pluginId: "router", factory: "routingGraph" },
    { pluginId: "example-override", factory: "override" },
  ]),
});
