// File preview: the header (identity, copy path, download) dispatches to a
// lazy viewer by file kind. Text and markdown fetch once here and share the
// read; images and media stream from the download endpoint with native
// decoding; everything else falls back to metadata + download.

import { Suspense, lazy, useEffect, useState } from "react";
import {
  ArrowLeft, ArrowSquareOut, Clock, Copy, FileAudio, FileImage, FilePdf,
  FileVideo, FileText,
} from "@phosphor-icons/react";
import type { FileKind } from "../../../shared/file-kind.ts";
import { MarkdownBody } from "../markdown.tsx";
import { downloadUrl, fetchText, type FileRef, type FilesTextData } from "./files-api.ts";

const CodeMirrorView = lazy(() => import("./CodeMirrorView.tsx"));

function formatBytes(size: number | undefined): string {
  if (size === undefined) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMtime(mtimeMs: number | undefined): string {
  if (mtimeMs === undefined) return "";
  return new Date(mtimeMs).toLocaleString();
}

function kindLabel(fileKind: FileKind): string {
  switch (fileKind) {
    case "text": return "Source";
    case "markdown": return "Markdown";
    case "image": return "Image";
    case "pdf": return "PDF";
    case "audio": return "Audio";
    case "video": return "Video";
    default: return "Binary";
  }
}

interface FilePreviewProps {
  sessionId: string;
  file: FileRef;
  onBack: () => void;
}

export function FilePreview({ sessionId, file, onBack }: FilePreviewProps) {
  const [text, setText] = useState<FilesTextData | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const wantsText = file.fileKind === "text" || file.fileKind === "markdown";

  useEffect(() => {
    if (!wantsText) return;
    let cancelled = false;
    setText(null);
    setTextError(null);
    void fetchText(sessionId, file.path).then((result) => {
      if (cancelled) return;
      if (result.ok) setText(result.data);
      else setTextError(result.message);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, file.path, wantsText]);

  const copyPath = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(file.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be denied; the path still renders in the header.
    }
  };

  const size = text !== null ? text.size : file.size;
  const mtime = text !== null ? text.mtimeMs : file.mtimeMs;

  return (
    <div className="files-preview" data-testid="files-preview">
      <div className="files-toolbar files-preview-header">
        <button type="button" className="files-icon-btn" aria-label="Back to files" onClick={onBack}>
          <ArrowLeft size={15} aria-hidden="true" />
        </button>
        <span className="files-row-icon">{previewIcon(file.fileKind)}</span>
        <span className="files-preview-title" title={file.path}>{file.name}</span>
        <span className="files-preview-kind">{kindLabel(file.fileKind)}</span>
      </div>

      <div className="files-preview-meta">
        <span className="files-preview-path" title={file.path}>{file.path}</span>
        <span className="files-preview-stat"><Clock size={12} aria-hidden="true" /> {formatMtime(mtime)}</span>
        <span className="files-preview-stat">{formatBytes(size)}</span>
        <button type="button" className="files-action" onClick={() => void copyPath()}>
          <Copy size={13} aria-hidden="true" /> {copied ? "Copied" : "Copy path"}
        </button>
        <a className="files-action" href={downloadUrl(sessionId, file.path, true)}>
          <ArrowSquareOut size={13} aria-hidden="true" /> Download
        </a>
      </div>

      <div className="files-preview-body">
        {previewBody()}
      </div>
    </div>
  );

  function previewBody() {
    if (wantsText && text === null && textError === null) {
      return <div className="files-empty">Loading…</div>;
    }
    if (wantsText && textError !== null) {
      return <div className="files-empty files-error" role="alert">{textError}</div>;
    }
    if (file.fileKind === "image") {
      return <ImagePreview sessionId={sessionId} file={file} />;
    }
    if (file.fileKind === "audio" || file.fileKind === "video") {
      return <MediaPreview sessionId={sessionId} file={file} kind={file.fileKind} />;
    }
    if (file.fileKind === "text" && text !== null) {
      return (
        <>
          {text.truncated ? <div className="files-truncated">File too large; showing the first 2 MiB.</div> : null}
          {text.binary
            ? <UnsupportedPreview file={file} sessionId={sessionId} note="Binary content." />
            : (
              <Suspense fallback={<div className="files-empty">Loading editor…</div>}>
                <CodeMirrorView text={text.text} />
              </Suspense>
            )}
        </>
      );
    }
    if (file.fileKind === "markdown" && text !== null) {
      return text.binary
        ? <UnsupportedPreview file={file} sessionId={sessionId} note="Binary content." />
        : <MarkdownPreview text={text.text} />;
    }
    return <UnsupportedPreview file={file} sessionId={sessionId} />;
  }
}

function previewIcon(fileKind: FileKind) {
  switch (fileKind) {
    case "image": return <FileImage size={15} aria-hidden="true" />;
    case "pdf": return <FilePdf size={15} aria-hidden="true" />;
    case "audio": return <FileAudio size={15} aria-hidden="true" />;
    case "video": return <FileVideo size={15} aria-hidden="true" />;
    default: return <FileText size={15} aria-hidden="true" />;
  }
}

function ImagePreview({ sessionId, file }: { sessionId: string; file: FileRef }) {
  const [errored, setErrored] = useState(false);
  if (errored) {
    return <UnsupportedPreview file={file} sessionId={sessionId} note="The image could not be rendered." />;
  }
  return (
    <div className="files-media files-image">
      <img
        src={downloadUrl(sessionId, file.path, false)}
        alt={file.name}
        onError={() => setErrored(true)}
      />
    </div>
  );
}

function MediaPreview({ sessionId, file, kind }: { sessionId: string; file: FileRef; kind: "audio" | "video" }) {
  const src = downloadUrl(sessionId, file.path, false);
  return (
    <div className="files-media">
      {kind === "audio" ? (
        <audio controls preload="metadata" src={src} aria-label={file.name} />
      ) : (
        <video controls preload="metadata" src={src} aria-label={file.name} className="files-video" />
      )}
    </div>
  );
}

function MarkdownPreview({ text }: { text: string }) {
  const [mode, setMode] = useState<"rendered" | "source">("rendered");
  return (
    <div className="files-markdown">
      <div className="files-markdown-toggle">
        <button
          type="button"
          className={`files-action${mode === "rendered" ? " is-active" : ""}`}
          onClick={() => setMode("rendered")}
        >
          Rendered
        </button>
        <button
          type="button"
          className={`files-action${mode === "source" ? " is-active" : ""}`}
          onClick={() => setMode("source")}
        >
          Source
        </button>
      </div>
      {mode === "rendered" ? (
        <div className="files-markdown-rendered"><MarkdownBody text={text} /></div>
      ) : (
        <pre className="files-source-pre">{text}</pre>
      )}
    </div>
  );
}

function UnsupportedPreview({ file, sessionId, note }: { file: FileRef; sessionId: string; note?: string }) {
  return (
    <div className="files-empty files-unsupported">
      <p>Preview unavailable for this file type.</p>
      {note !== undefined ? <p className="files-unsupported-note">{note}</p> : null}
      <p className="files-unsupported-name">{file.name}</p>
      <a className="files-action" href={downloadUrl(sessionId, file.path, true)}>
        <ArrowSquareOut size={13} aria-hidden="true" /> Download
      </a>
    </div>
  );
}