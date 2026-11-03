import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { closeSharedBrowser, readWebPage } from "../lib/web-read.ts";
import { stringEnum } from "../lib/schema.ts";

export default function webReadExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_read",
    label: "Web Read",
    description:
      "Read and extract clean readable content from any web page using a lightweight headless browser. " +
      "Executes client-side JavaScript (SPAs, React, Vue, Next.js, etc.) and converts the rendered DOM to clean Markdown. " +
      "Use this whenever you need to open, inspect, or read content from a referenced URL.",
    promptSnippet: "Lightweight headless browser web page reader with JavaScript rendering support",
    promptGuidelines: [
      "Use web_read to open and read referenced website URLs or documentation pages.",
      "Handles dynamic single-page applications (React, Vue, Vite, Next.js) where direct HTTP fetching fails.",
      "Optionally pass selector (e.g. 'article', 'main', '#content') to extract specific content containers.",
    ],
    parameters: Type.Object({
      url: Type.String({
        description: "The URL of the website or webpage to open and read.",
      }),
      selector: Type.Optional(
        Type.String({
          description: "Optional CSS selector to scope extraction (e.g. 'main', 'article', '#docs-content').",
        }),
      ),
      waitForSelector: Type.Optional(
        Type.String({
          description: "Optional CSS selector to wait for before extracting content (useful for client-rendered apps).",
        }),
      ),
      format: Type.Optional(
        stringEnum(["markdown", "text", "html"], {
          description: "Output format: 'markdown' (default), 'text', or 'html'.",
        }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Number({
          description: "Timeout in seconds for navigation and extraction (default: 20, max: 60).",
        }),
      ),
    }),
    annotations: {
      readOnlyHint: true,
    },
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      onUpdate?.({
        content: [{ type: "text", text: `Opening ${params.url} in headless browser…` }],
        details: {},
      });

      const result = await readWebPage({
        url: params.url,
        selector: params.selector,
        waitForSelector: params.waitForSelector,
        format: params.format as "markdown" | "text" | "html" | undefined,
        timeoutSeconds: params.timeoutSeconds,
        signal,
      });

      const header = `# ${result.title || "Web Page"}\nURL: ${result.url}\n\n`;
      return {
        content: [{ type: "text", text: `${header}${result.content}` }],
        details: {
          url: result.url,
          title: result.title,
          characterCount: result.characterCount,
          truncated: result.truncated,
        },
      };
    },
  });

  pi.on("session_shutdown", async () => {
    await closeSharedBrowser().catch(() => {});
  });
}
