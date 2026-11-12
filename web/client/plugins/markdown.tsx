// Safe markdown rendering built on react-markdown + remark-gfm — the same
// stack the TUI-era web app used. Safety: react-markdown never renders raw
// HTML without rehype-raw (not used here), and the URL transform below
// admits only http(s) links and in-page anchors — model and plugin output
// stays data, never markup.

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { memo, useEffect, useState } from "react";

// Mermaid is a large library and only needed when a ```mermaid fence appears,
// so it is loaded on first use (the bundler splits it into its own chunk).
type MermaidApi = typeof import("mermaid").default;
let mermaidApi: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  mermaidApi ??= import("mermaid").then((mod) => {
    // Configured once: startOnLoad keeps it inert until the first render.
    mod.default.initialize({ startOnLoad: false, theme: "default" });
    return mod.default;
  });
  return mermaidApi;
}

/** Render one fenced ```mermaid block to SVG on the client. */
const MermaidBlock = memo(function MermaidBlock({ chart }: { chart: string }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `mmd-${Math.random().toString(36).slice(2, 10)}`;
    void (async () => {
      try {
        const mermaid = await loadMermaid();
        const rendered = await mermaid.render(id, chart);
        if (!cancelled) {
          setSvg(rendered.svg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (error !== null) {
    return (
      <div className="markdown-mermaid-error" role="alert">
        Mermaid could not render this diagram: {error}
      </div>
    );
  }

  // The SVG comes from mermaid's strict sanitisation, never from raw markup.
  return <div className="markdown-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
});

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  code({ className, children, ...props }) {
    if (className === "language-mermaid") {
      return <MermaidBlock chart={String(children).replace(/\n$/, "")} />;
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  pre({ node, children, ...props }) {
    // Unwrap the <pre> around a fenced ```mermaid block so the SVG isn't
    // forced into white-space:pre inside a code card.
    const codeNode = node?.children[0];
    const isMermaid =
      codeNode !== undefined &&
      codeNode.type === "element" &&
      codeNode.tagName === "code" &&
      Array.isArray(codeNode.properties?.className) &&
      codeNode.properties.className.includes("language-mermaid");
    return isMermaid ? <>{children}</> : <pre {...props}>{children}</pre>;
  },
};

/** Only http(s) URLs and in-page anchors survive; anything else drops to "#". */
function safeUrlTransform(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("#")) return url;
  return "#";
}

/** Render a markdown string (GFM: tables, strikethrough, autolinks) safely.
 * Memoized by text: the transcript re-renders on every stream delta, plugin
 * state frame and status change, and re-parsing every historical message
 * each time is the flicker/jank users saw ("blipping"). */
export const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrlTransform}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});