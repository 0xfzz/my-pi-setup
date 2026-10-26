/**
 * Security policy for the dashboard renderer.
 *
 * This module has no dependencies and never touches the network. It is shared
 * by the browser bundle and by Node tests. DOM-dependent functions take a
 * `window`-like object so the same allowlists are exercised in both places.
 *
 * Threat model:
 *  - Artifact content, session/child names and DOT labels are untrusted.
 *  - Rendered documents must never execute script, load remote resources, or
 *    navigate to filesystem/`javascript:`/`data:` URLs.
 *  - Graphviz output is generated from escaped DOT, then run through the SVG
 *    allowlist below as defence in depth.
 */

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:"]);

/** True only for absolute http(s) links without embedded credentials. */
export function isSafeLinkUrl(raw) {
  if (typeof raw !== "string") return false;
  const value = raw.trim();
  if (!value || value.length > 2048) return false;
  if (value.startsWith("//")) return false; // scheme-relative -> external surprise
  if (!/^https?:\/\//i.test(value)) return false;
  if (/[\u0000-\u001f\u007f\s]/.test(value.replace(/^https?:\/\//i, ""))) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!SAFE_LINK_PROTOCOLS.has(url.protocol)) return false;
  if (url.username || url.password) return false;
  return true;
}

/**
 * Escape a string for a double-quoted DOT string literal.
 *
 * Backslashes are escaped so Graphviz escape sequences (`\N`, `\l`, …) in
 * untrusted labels stay literal, quotes cannot terminate the literal, and all
 * control characters (including newlines) become spaces.
 */
export function escapeDotString(value, maxLength = 72) {
  let text = String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > maxLength) text = `${text.slice(0, Math.max(0, maxLength - 1))}…`;
  return text || " ";
}

/** Attribution/label sanitizer used for non-DOT UI text. */
export function safeText(value, maxLength = 200) {
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

const DROP_TAGS = new Set([
  "script", "style", "foreignobject", "iframe", "frame", "frameset", "object", "embed",
  "applet", "image", "use", "animate", "animatemotion", "animatetransform", "set",
  "audio", "video", "source", "track", "canvas", "form", "input", "button", "textarea",
  "select", "option", "link", "meta", "base", "template", "math", "handler", "listener",
]);

const ALLOWED_SVG_TAGS = new Set([
  "svg", "g", "path", "polygon", "polyline", "rect", "circle", "ellipse", "line",
  "text", "tspan", "textpath", "title", "desc", "defs", "marker", "clippath",
  "lineargradient", "radialgradient", "stop",
]);

const ALLOWED_SVG_ATTRS = new Set([
  "id", "class", "transform", "d", "points", "x", "y", "dx", "dy", "x1", "y1", "x2",
  "y2", "width", "height", "rx", "ry", "cx", "cy", "r", "fill", "fill-opacity",
  "fill-rule", "stroke", "stroke-width", "stroke-dasharray", "stroke-dashoffset",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "opacity",
  "font-family", "font-size", "font-weight", "font-style", "font-variant",
  "letter-spacing", "text-anchor", "text-decoration", "dominant-baseline", "alignment-baseline",
  "baseline-shift", "paint-order", "viewbox", "preserveaspectratio", "version", "xmlns",
  "xmlns:xlink", "xml:space", "marker-start", "marker-mid", "marker-end", "clip-path",
  "overflow", "role", "aria-label", "focusable", "shape-rendering",
]);

const UNSAFE_ATTR_VALUE = /(?:url\s*\(|javascript\s*:|vbscript\s*:|data\s*:|expression\s*\(|@import|behavior\s*:)/i;

function unwrapElement(element) {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
}

/**
 * Sanitize generated Graphviz SVG.
 *
 * @param {string} svgText raw SVG markup
 * @param {{DOMParser: any, XMLSerializer: any}} dom window-like object
 * @returns {string} sanitized SVG markup, or "" when the document is invalid
 */
export function sanitizeSvgMarkup(svgText, dom) {
  if (typeof svgText !== "string" || !svgText.trim() || !dom?.DOMParser || !dom?.XMLSerializer) return "";
  let doc;
  try {
    doc = new dom.DOMParser().parseFromString(svgText, "image/svg+xml");
  } catch {
    return "";
  }
  if (!doc?.documentElement) return "";
  if (typeof doc.getElementsByTagName === "function" && doc.getElementsByTagName("parsererror").length > 0) return "";

  const root = doc.documentElement;
  const elements = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const element of elements) {
    if (!element.isConnected && element !== root) continue;
    const tag = String(element.localName || element.tagName || "").toLowerCase();
    if (!ALLOWED_SVG_TAGS.has(tag)) {
      if (tag === "a") unwrapElement(element);
      else element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const local = String(attribute.localName || "").toLowerCase();
      if (name.startsWith("on") || local.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (local === "href") {
        // Only same-document fragment references are harmless; the dashboard
        // never emits links inside SVG, so a plain strip is acceptable.
        if (!attribute.value.trim().startsWith("#")) element.removeAttribute(attribute.name);
        continue;
      }
      if (!ALLOWED_SVG_ATTRS.has(name) && !ALLOWED_SVG_ATTRS.has(local)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (UNSAFE_ATTR_VALUE.test(attribute.value)) element.removeAttribute(attribute.name);
    }
  }
  try {
    return new dom.XMLSerializer().serializeToString(doc.documentElement);
  } catch {
    return "";
  }
}

const MARKDOWN_TAGS = [
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
  "blockquote", "pre", "code", "strong", "em", "b", "i", "del", "s", "sub", "sup",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "a", "span", "div", "dl", "dt", "dd",
];

const MARKDOWN_ATTRS = [
  "href", "title", "class", "align", "colspan", "rowspan", "start", "rel", "target", "reversed",
];

const PRE_STRIP_TAGS = [
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet",
  "form", "input", "button", "textarea", "select", "option", "link", "meta", "base",
  "video", "audio", "source", "track", "picture", "svg", "math", "template", "canvas",
];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}

const ACTIVE_BLOCK = /<(script|style|iframe|frame|frameset|object|embed|applet|form|template|svg|math|picture|video|audio|source|track|link|meta|base|input|button|textarea|select)\b[\s\S]*?<\/\1\s*>/gi;
const ACTIVE_VOID = /<(script|style|iframe|frame|frameset|object|embed|applet|form|template|svg|math|picture|video|audio|source|track|link|meta|base|input|button|textarea|select)\b[^>]*\/?>/gi;
const IMG_TAG = /<img\b[^>]*>/gi;
const INLINE_HANDLER = /\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const ACTIVE_ATTRIBUTE = /\s(?:style|xlink:href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;

/**
 * Remove tags that can load or execute before the HTML reaches any DOM.
 *
 * Chrome still loads `<img src>` inside a `<template>`'s inert content, which
 * would fire `onerror` (and log a CSP violation). Markdown is therefore
 * pre-cleaned as a string first; escaped code fences are unaffected.
 */
export function stripActiveMarkup(html) {
  return String(html ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(ACTIVE_BLOCK, "")
    .replace(ACTIVE_VOID, "")
    .replace(IMG_TAG, (tag) => {
      const alt = /\balt\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
      const label = safeText(alt ? alt[2] ?? alt[3] ?? "" : "remote image", 120);
      return ` <span class="md-media-blocked">[image blocked: ${escapeHtml(label)}]</span> `;
    })
    .replace(INLINE_HANDLER, "")
    .replace(ACTIVE_ATTRIBUTE, "");
}

/**
 * Render untrusted Markdown to sanitized HTML.
 *
 * Remote images are replaced with a text placeholder (never fetched); unsafe
 * link targets are unwrapped to plain text; safe links open in a new tab with
 * `noopener noreferrer nofollow`.
 *
 * @param {string} markdown
 * @param {{marked: any, DOMPurify: any, dom: any}} deps
 */
export function renderMarkdownSafe(markdown, { marked, DOMPurify, dom } = {}) {
  if (!marked || !DOMPurify || !dom?.document) return "";
  let rawHtml;
  try {
    rawHtml = marked.parse(String(markdown ?? ""), { gfm: true, async: false, breaks: false });
  } catch {
    rawHtml = `<pre>${String(markdown ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</pre>`;
  }
  if (typeof rawHtml !== "string") rawHtml = "";
  rawHtml = stripActiveMarkup(rawHtml);

  const doc = dom.document;
  const holder = doc.createElement("template");
  holder.innerHTML = rawHtml;

  for (const tag of PRE_STRIP_TAGS) {
    for (const node of Array.from(holder.content.querySelectorAll(tag))) node.remove();
  }
  for (const image of Array.from(holder.content.querySelectorAll("img"))) {
    const alt = safeText(image.getAttribute("alt") || "remote image", 120);
    const placeholder = doc.createElement("span");
    placeholder.className = "md-media-blocked";
    placeholder.textContent = `[image blocked: ${alt}]`;
    image.replaceWith(placeholder);
  }

  let clean;
  try {
    clean = DOMPurify.sanitize(holder.innerHTML, {
      ALLOWED_TAGS: MARKDOWN_TAGS,
      ALLOWED_ATTR: MARKDOWN_ATTRS,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      FORBID_TAGS: ["img", "svg", "math", "style", "form", "input", "button", "iframe", "object", "embed", "script", "link", "meta", "base"],
      FORBID_ATTR: ["style", "src", "srcset", "id", "name"],
      KEEP_CONTENT: true,
      RETURN_TRUSTED_TYPE: false,
    });
  } catch {
    return "";
  }

  const output = doc.createElement("template");
  output.innerHTML = clean;
  for (const anchor of Array.from(output.content.querySelectorAll("a"))) {
    const href = anchor.getAttribute("href");
    if (!isSafeLinkUrl(href)) {
      const span = doc.createElement("span");
      span.className = "md-link-blocked";
      span.textContent = anchor.textContent || "";
      anchor.replaceWith(span);
      continue;
    }
    anchor.setAttribute("rel", "noopener noreferrer nofollow ugc");
    anchor.setAttribute("target", "_blank");
    anchor.classList.add("md-link-external");
    anchor.setAttribute("title", `${href} (external link, opens in a new tab)`);
  }
  return output.innerHTML;
}

export const __security = { DROP_TAGS, ALLOWED_SVG_TAGS, ALLOWED_SVG_ATTRS, PRE_STRIP_TAGS };
