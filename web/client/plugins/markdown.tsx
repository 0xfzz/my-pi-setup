// Safe markdown rendering built on react-markdown + remark-gfm — the same
// stack the TUI-era web app used. Safety: react-markdown never renders raw
// HTML without rehype-raw (not used here), and the URL transform below
// admits only http(s) links and in-page anchors — model and plugin output
// stays data, never markup.

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { memo } from "react";

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
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
