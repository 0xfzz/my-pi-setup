// Read-only CodeMirror 6 view for large text/source files. It is the default
// export so FilePreview can `React.lazy` it: esbuild code-splits it (plus
// CodeMirror) out of the main bundle, fetched only when a text file opens.

import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";

export default function CodeMirrorView({ text }: { text: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const state = EditorState.create({
      doc: text,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        lineNumbers(),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [text]);

  return (
    <div className="files-code-view" data-testid="files-code-view">
      <div ref={hostRef} className="files-code-editor" />
    </div>
  );
}