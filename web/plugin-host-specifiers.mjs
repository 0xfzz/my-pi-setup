/**
 * Single source of truth for the browser modules shared by the host app and
 * manifest-discovered plugin bundles. The build emits the shims and derives
 * the document import map from this registry.
 */
export const HOST_MODULES = Object.freeze({
  react: "react.js",
  "react/jsx-runtime": "jsx-runtime.js",
  "react-dom": "react-dom.js",
  "react-dom/client": "react-dom-client.js",
  "@phosphor-icons/react": "phosphor.js",
  "@file-viewer/react": "file-viewer-react.js",
  "@file-viewer/core": "file-viewer-core.js",
  "@file-viewer/preset-office": "file-viewer-office.js",
  "@pi-web/bridge": "sdk.js",
  "@pi-web/bridge/text": "sdk-text.js",
  "@pi-web/host-ui": "ui.js",
});

export const HOST_SPECIFIERS = Object.freeze(Object.keys(HOST_MODULES));

/**
 * First-party entries bundle icons themselves. The hosted phosphor shim still
 * exists for external plugins, but keeping it external here would pull every
 * icon into the initial page load through the shared runtime.
 */
export const FIRST_PARTY_EXTERNALS = Object.freeze(
  HOST_SPECIFIERS.filter((specifier) => specifier !== "@phosphor-icons/react"),
);

/** The browser import map, derived from the same registry as the shims. */
export function hostImportMap(base = "/host/") {
  return Object.fromEntries(Object.entries(HOST_MODULES).map(([specifier, file]) => [specifier, `${base}${file}`]));
}
