// In-browser PDF preview via pdf.js. The bytes are fetched (fetch is not
// subject to X-Frame-Options, unlike an <iframe>) and each page is drawn to a
// canvas on the main thread. Lazy-loaded by FilePreview so the ~900 KB library
// stays out of the critical bundle.

import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import { LoadingSpinner } from "../../core/client/plugin-system/LoadingSpinner.tsx";
import { downloadUrl, type FileRef } from "./files-api.ts";

// The worker file is copied into dist/ by build.mjs and served at this path.
GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

interface PdfViewerProps {
  sessionId: string;
  file: FileRef;
}

export function PdfViewer({ sessionId, file }: PdfViewerProps) {
  const pagesRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const host = pagesRef.current;
    if (!host) return;
    let cancelled = false;

    const renderPdf = async (host: HTMLDivElement): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(downloadUrl(sessionId, file.path, false));
        if (!response.ok) throw new Error(`could not load the PDF (HTTP ${response.status})`);
        const pdf = await getDocument({ data: await response.arrayBuffer() }).promise;
        if (cancelled) return;
        setLoading(false);

        for (let pageNumber = 1; pageNumber <= pdf.numPages && !cancelled; pageNumber += 1) {
          const page = await pdf.getPage(pageNumber);
          const viewport = page.getViewport({ scale: 1.5 });
          const canvas = document.createElement("canvas");
          canvas.className = "files-pdf-page";
          host.append(canvas);
          await page.render({ canvas, viewport }).promise;
          page.cleanup();
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void renderPdf(host);
    return () => {
      cancelled = true;
      host.replaceChildren();
    };
  }, [sessionId, file.path]);

  if (error !== null) {
    return <div className="files-empty files-error" role="alert">{error}</div>;
  }

  return (
    <div className="files-pdf">
      {loading ? <LoadingSpinner label="Rendering PDF…" /> : null}
      <div className="files-pdf-pages" ref={pagesRef} />
    </div>
  );
}