// Document preview via Flyfish File Viewer (file-viewer.app): PDF, Word,
// Excel and PowerPoint render in-browser from the streamed bytes — no server
// conversion and no pdf.js wiring of our own. The renderer is a large vendor
// library, so its three packages are imported only when a document opens;
// FilePreview already wraps this component in a Suspense boundary. Shadow-DOM
// style isolation is the default, so the panel's CSS can neither break the
// viewer nor the other way round.

import { use, type CSSProperties } from "react";
import type { FileViewerOptions } from "@file-viewer/core";
import { LoadingSpinner } from "@pi-web/host-ui";
import { downloadUrl, type FileRef } from "./lib/files-api.ts";

type CoreModule = typeof import("@file-viewer/core") & { FILE_VIEWER_ASSET_BASE_URL: string };

type ViewerModules = {
  FileViewer: typeof import("@file-viewer/react").FileViewer;
  useFileViewerState: typeof import("@file-viewer/react").useFileViewerState;
  options: FileViewerOptions;
};

let viewerModules: Promise<ViewerModules> | undefined;

function loadViewerModules(): Promise<ViewerModules> {
  viewerModules ??= Promise.all([
    import("@file-viewer/react"),
    import("@file-viewer/core"),
    import("@file-viewer/preset-office"),
  ]).then(([react, core, office]) => {
    // The bundled default derives the asset base from import.meta.url, which
    // esbuild rewrites to a module URL: workers then 404 at the site root.
    const registeredCore = core as CoreModule;
    registeredCore.setDefaultFileViewerAssetBaseUrl(registeredCore.FILE_VIEWER_ASSET_BASE_URL);
    const options: FileViewerOptions = {
      preset: office.default,
      rendererMode: "replace",
      theme: "light", // Documents render as paper regardless of the app theme.
      toolbar: { position: "bottom-right" },
    };
    return { FileViewer: react.FileViewer, useFileViewerState: react.useFileViewerState, options };
  });
  return viewerModules;
}

// The viewer's floating toolbar lives in its shadow DOM; these inherited
// custom properties give its controls thumb-sized hit areas without editing
// vendor CSS.
const VIEWER_STYLE = {
  "--file-viewer-floating-button-min-width": "44px",
  "--file-viewer-floating-button-height": "44px",
  "--file-viewer-floating-icon-button-size": "44px",
  "--file-viewer-floating-search-input-height": "44px",
} as CSSProperties;

interface DocumentViewerProps {
  sessionId: string;
  file: FileRef;
}

export function DocumentViewer({ sessionId, file }: DocumentViewerProps) {
  const { FileViewer, useFileViewerState, options } = use(loadViewerModules());
  const { state, onStateChange } = useFileViewerState();
  const loading = !state.ready && state.error === null;
  return (
    <div className="files-document" data-testid="files-document" aria-busy={loading}>
      {loading ? <div className="files-media-loading"><LoadingSpinner label="Loading document…" /></div> : null}
      {state.error !== null ? (
        <div className="files-empty files-error" role="alert">
          {state.error instanceof Error ? state.error.message : "The document could not be loaded. Try Download instead."}
        </div>
      ) : null}
      <FileViewer
        className="files-document-view file-viewer-toolbar"
        style={VIEWER_STYLE}
        onStateChange={onStateChange}
        url={downloadUrl(sessionId, file.path, false)}
        filename={file.name}
        size={file.size}
        options={options}
      />
    </div>
  );
}
