// Artifact preview: a metadata header plus a body rendered by kind. Code
// artifacts open in read-only CodeMirror; everything else renders as markdown
// with a rendered/source toggle (CodeMirror for the source, so large specs
// stay smooth). Mirrors the Files preview's structure.

import { Suspense, lazy, useState } from "react";
import { ArrowLeft, Clock, Copy } from "@phosphor-icons/react";
import { MarkdownBody } from "../markdown.tsx";
import { artifactBodyKind, parseArtifactDetail } from "./artifact-detail.ts";

const CodeMirrorView = lazy(() => import("../files/CodeMirrorView.tsx"));

function formatBytes(content: string): string {
  const bytes = new TextEncoder().encode(content).length;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface ArtifactPreviewProps {
  title: string;
  detail: string | null;
  onBack: () => void;
}

export function ArtifactPreview({ title, detail, onBack }: ArtifactPreviewProps) {
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<"rendered" | "source">("rendered");
  const parsed = detail === null ? null : parseArtifactDetail(detail);
  const meta = parsed?.meta;
  const content = parsed?.content ?? "";
  const kind = meta === undefined ? "markdown" : artifactBodyKind(meta.type);

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be denied; the value still renders on screen.
    }
  };

  return (
    <div className="artifacts-preview" data-testid="artifacts-preview">
      <div className="artifacts-toolbar artifacts-preview-header">
        <button type="button" className="artifacts-icon-btn" aria-label="Back to catalog" onClick={onBack}>
          <ArrowLeft size={15} aria-hidden="true" />
        </button>
        <span className="artifacts-preview-title" title={title}>{title}</span>
        {meta !== undefined ? (
          <span className="artifacts-preview-kind">{meta.type} · v{meta.version}</span>
        ) : null}
      </div>

      <div className="artifacts-preview-meta">
        {meta?.id ? (
          <button
            type="button"
            className="artifacts-action artifacts-preview-id"
            title={`Copy artifact id: ${meta.id}`}
            onClick={() => void copy(meta.id)}
          >
            #{meta.id}
          </button>
        ) : null}
        <span className="artifacts-preview-stat">{(meta?.size ?? "") || formatBytes(content)}</span>
        {meta?.author ? <span className="artifacts-preview-stat">by {meta.author}</span> : null}
        {meta?.updatedAt ? (
          <span className="artifacts-preview-stat"><Clock size={12} aria-hidden="true" /> {meta.updatedAt}</span>
        ) : null}
        {meta?.tags.length ? (
          <span className="artifacts-preview-tags">{meta.tags.map((tag) => `#${tag}`).join(" ")}</span>
        ) : null}
        <button type="button" className="artifacts-action" onClick={() => void copy(content)} disabled={content === ""}>
          <Copy size={13} aria-hidden="true" /> {copied ? "Copied" : "Copy content"}
        </button>
      </div>

      <div className="artifacts-preview-body">
        {detail === null ? (
          <div className="artifacts-empty">No content recorded for this artifact.</div>
        ) : kind === "code" ? (
          <Suspense fallback={<div className="artifacts-empty">Loading editor…</div>}>
            <CodeMirrorView text={content} />
          </Suspense>
        ) : (
          <div className="artifacts-markdown">
            <div className="artifacts-markdown-toggle">
              <button
                type="button"
                className={`artifacts-action${mode === "rendered" ? " is-active" : ""}`}
                onClick={() => setMode("rendered")}
              >
                Rendered
              </button>
              <button
                type="button"
                className={`artifacts-action${mode === "source" ? " is-active" : ""}`}
                onClick={() => setMode("source")}
              >
                Source
              </button>
            </div>
            {mode === "rendered" ? (
              <div className="artifacts-markdown-rendered"><MarkdownBody text={content} /></div>
            ) : (
              <pre className="artifacts-source-pre">{content}</pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}