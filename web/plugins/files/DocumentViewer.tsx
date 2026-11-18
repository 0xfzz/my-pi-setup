// Document preview via Flyfish File Viewer (file-viewer.app): PDF, Word,
// Excel and PowerPoint render in-browser from the streamed bytes — no server
// conversion and no pdf.js wiring of our own. The heavy renderers are lazy
// per format; their Workers/WASM/fonts are self-hosted under /file-viewer/
// (copied by build.mjs). Lazy-loaded by FilePreview so the viewer chunk stays
// out of the critical bundle. Shadow-DOM style isolation is the default, so
// the panel's CSS can neither break the viewer nor the other way round.

import type { CSSProperties } from "react";
import FileViewer, { useFileViewerState } from "@file-viewer/react";
import { setDefaultFileViewerAssetBaseUrl, type FileViewerOptions } from "@file-viewer/core";
import officePreset from "@file-viewer/preset-office";
import { downloadUrl, type FileRef } from "./lib/files-api.ts";
import { LoadingSpinner } from "@pi-web/host-ui";

// The bundled default derives the asset base from import.meta.url, which
// esbuild rewrites to a chunk URL: workers then 404 at the site root. Pin it
// to the self-hosted copy build.mjs writes into dist/file-viewer/.
setDefaultFileViewerAssetBaseUrl("/file-viewer/");

// State notifications re-render this component. A stable options reference
// keeps those renders from issuing another viewer.update (and notification).
const DOCUMENT_OPTIONS: FileViewerOptions = {
  preset: officePreset,
  rendererMode: "replace",
  theme: "light", // Documents render as paper regardless of the app theme.
  toolbar: { position: "bottom-right" },
};

// The viewer's floating toolbar lives in its shadow DOM; these inherited
// custom properties are the supported way to give its controls thumb-sized
// hit areas without editing vendor CSS.
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
        options={DOCUMENT_OPTIONS}
      />
    </div>
  );
}
