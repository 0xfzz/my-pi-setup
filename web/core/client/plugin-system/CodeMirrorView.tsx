// Shared read-only CodeMirror 6 view. It is the default export so plugin
// previews can `React.lazy` it: esbuild splits CodeMirror into a separate
// chunk, fetched only when a text preview opens.

import { useEffect, useRef } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { EditorView, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { codeLanguageForFilename, type CodeLanguage } from "./code-language.ts";

const languageCompartment = new Compartment();

// Colors come from theme tokens so a live dark/light toggle recolors tokens
// without rebuilding the editor or reloading a language.
const syntaxTheme = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--code-comment)" },
  {
    tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.operatorKeyword],
    color: "var(--code-keyword)",
  },
  { tag: [t.string, t.special(t.string), t.regexp, t.url], color: "var(--code-string)" },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom], color: "var(--code-number)" },
  { tag: [t.typeName, t.className, t.namespace, t.macroName], color: "var(--code-type)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--code-function)" },
  {
    tag: [t.variableName, t.propertyName, t.labelName, t.definition(t.variableName)],
    color: "var(--code-variable)",
  },
  { tag: t.tagName, color: "var(--code-tag)" },
  { tag: [t.attributeName, t.meta], color: "var(--code-attribute)" },
  { tag: [t.punctuation, t.separator, t.bracket, t.operator], color: "var(--code-punctuation)" },
]);

const LANGUAGE_LOADERS: Readonly<Record<CodeLanguage, () => Promise<Extension>>> = Object.freeze({
  css: () => import("@codemirror/lang-css").then((module) => module.css()),
  html: () => import("@codemirror/lang-html").then((module) => module.html()),
  javascript: () => import("@codemirror/lang-javascript").then((module) => module.javascript()),
  jsx: () => import("@codemirror/lang-javascript").then((module) => module.javascript({ jsx: true })),
  json: () => import("@codemirror/lang-json").then((module) => module.json()),
  python: () => import("@codemirror/lang-python").then((module) => module.python()),
  rust: () => import("@codemirror/lang-rust").then((module) => module.rust()),
  shell: () => import("@codemirror/legacy-modes/mode/shell").then((module) => StreamLanguage.define(module.shell)),
  tsx: () => import("@codemirror/lang-javascript").then((module) => module.javascript({ typescript: true, jsx: true })),
  typescript: () => import("@codemirror/lang-javascript").then((module) => module.javascript({ typescript: true })),
  yaml: () => import("@codemirror/lang-yaml").then((module) => module.yaml()),
});

interface CodeMirrorViewProps {
  text: string;
  filename?: string;
}

export default function CodeMirrorView({ text, filename }: CodeMirrorViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let cancelled = false;
    const state = EditorState.create({
      doc: text,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        lineNumbers(),
        syntaxHighlighting(syntaxTheme),
        languageCompartment.of([]),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;

    const language = codeLanguageForFilename(filename);
    if (language !== undefined) {
      void LANGUAGE_LOADERS[language]().then((extension) => {
        if (!cancelled) view.dispatch({ effects: languageCompartment.reconfigure(extension) });
      }).catch(() => {
        // An unavailable chunk must not make the plain-text preview fail.
      });
    }

    return () => {
      cancelled = true;
      view.destroy();
      viewRef.current = null;
    };
  }, [text, filename]);

  return (
    <div className="host-code-view" data-testid="host-code-view">
      <div ref={hostRef} className="host-code-editor" />
    </div>
  );
}
