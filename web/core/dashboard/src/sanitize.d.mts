export function isSafeLinkUrl(raw: unknown): boolean;
export function escapeDotString(value: unknown, maxLength?: number): string;
export function safeText(value: unknown, maxLength?: number): string;
export function sanitizeSvgMarkup(svgText: string, dom: any): string;
export function stripActiveMarkup(html: string): string;
export function renderMarkdownSafe(
  markdown: string,
  deps: { marked: any; DOMPurify: any; dom: any },
): string;
export const __security: {
  DROP_TAGS: Set<string>;
  ALLOWED_SVG_TAGS: Set<string>;
  ALLOWED_SVG_ATTRS: Set<string>;
  PRE_STRIP_TAGS: string[];
};
