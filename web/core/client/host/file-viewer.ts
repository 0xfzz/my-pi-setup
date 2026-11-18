/**
 * Vendor-only bundle behind the `@file-viewer/*` import-map shims. It owns no
 * plugin UI or state: the files plugin imports it lazily when previewing a
 * document, keeping renderers, workers and fonts off the initial page load.
 */
export { default as FileViewerDefault, FileViewer, useFileViewerState } from "@file-viewer/react";
export { setDefaultFileViewerAssetBaseUrl } from "@file-viewer/core";
export { default as officePresetDefault } from "@file-viewer/preset-office";
