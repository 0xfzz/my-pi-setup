// Shared read-only CodeMirror 6 view. It is the default export so plugin
// previews can `React.lazy` it: esbuild splits CodeMirror into a separate
// chunk, fetched only when a text preview opens.

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
    <div className="host-code-view" data-testid="host-code-view">
      <div ref={hostRef} className="host-code-editor" />
    </div>
  );
}