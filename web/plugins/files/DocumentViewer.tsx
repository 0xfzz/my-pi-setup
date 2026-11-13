// Document preview via Flyfish File Viewer (file-viewer.app): PDF, Word,
// Excel and PowerPoint render in-browser from the streamed bytes — no server
// conversion and no pdf.js wiring of our own. The heavy renderers are lazy
// per format; their Workers/WASM/fonts are self-hosted under /file-viewer/
// (copied by build.mjs). Lazy-loaded by FilePreview so the viewer chunk stays
// out of the critical bundle. Shadow-DOM style isolation is the default, so
// the panel's CSS can neither break the viewer nor the other way round.

import FileViewer from "@file-viewer/react";
import { setDefaultFileViewerAssetBaseUrl } from "@file-viewer/core";
import officePreset from "@file-viewer/preset-office";
import { downloadUrl, type FileRef } from "./lib/files-api.ts";

// The bundled default derives the asset base from import.meta.url, which
// esbuild rewrites to a chunk URL: workers then 404 at the site root. Pin it
// to the self-hosted copy build.mjs writes into dist/file-viewer/.
setDefaultFileViewerAssetBaseUrl("/file-viewer/");

interface DocumentViewerProps {
  sessionId: string;
  file: FileRef;
}

export function DocumentViewer({ sessionId, file }: DocumentViewerProps) {
  return (
    <div className="files-document" data-testid="files-document">
      <FileViewer
        className="files-document-view"
        url={downloadUrl(sessionId, file.path, false)}
        filename={file.name}
        size={file.size}
        options={{
          preset: officePreset,
          rendererMode: "replace",
          // Documents render as paper; a fixed light theme keeps them readable
          // and avoids the viewer re-theming with the app chrome.
          theme: "light",
          toolbar: { position: "bottom-right" },
        }}
      />
    </div>
  );
}
