/**
 * File-viewer registration. The files plugin owns the source, generated
 * bundle and static assets; core only serves the generated output.
 */

export const FILE_VIEWER_BUNDLE_OUTDIR = "plugins/files";
export const FILE_VIEWER_MODULE_BASE = `/${FILE_VIEWER_BUNDLE_OUTDIR}/`;
export const FILE_VIEWER_ASSET_DIR = "file-viewer";
export const FILE_VIEWER_ASSET_OUTDIR = `${FILE_VIEWER_BUNDLE_OUTDIR}/${FILE_VIEWER_ASSET_DIR}`;
export const FILE_VIEWER_ASSET_URL = `${FILE_VIEWER_MODULE_BASE}${FILE_VIEWER_ASSET_DIR}/`;

/** Viewer files once emitted by core; the build removes stale copies. */
export const LEGACY_CORE_HOST_FILES: readonly string[] = Object.freeze([
  "file-viewer.js",
  "file-viewer-react.js",
  "file-viewer-core.js",
  "file-viewer-office.js",
]);

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
