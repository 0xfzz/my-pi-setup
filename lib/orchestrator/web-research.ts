/**
 * web-research.ts — bounded, cited web evidence without a page cache on disk.
 *
 * Two ports, so the module stays testable and cache-free: a search provider for
 * discovery and a fetch provider for extraction. The caller decides where (and
 * whether) to cache — normally the scratch workspace — so this file imports no
 * filesystem module at all.
 *
 * Web content is untrusted data: it is returned as text with a digest and a
 * citation, never executed and never treated as an instruction. Every failure
 * becomes a warning, except a missing provider, which is a capability error —
 * an empty list would read as "nothing exists".
 */
import { createHash } from "node:crypto";

export interface WebFetchResponse {
  ok: boolean;
  status: number;
  text: string;
  contentType?: string;
  finalUrl?: string;
  error?: string;
}

export interface WebFetchPort {
  fetch(url: string, options: { maxBytes: number; timeoutMs: number }): Promise<WebFetchResponse>;
}

export interface WebSearchHit {
  url: string;
  title: string;
  snippet?: string;
}

export interface WebSearchPort {
  search(query: string, options: { limit: number; recency?: string }): Promise<WebSearchHit[]>;
}

export interface WebResearchInput {
  query: string;
  urls?: string[];
  maxResults?: number;
  maxPages?: number;
  maxBytesPerPage?: number;
  recency?: "day" | "week" | "month" | "year";
}

export interface WebSource {
  url: string;
  title: string;
  fetchedAt: string;
  sha256: string;
  excerpt: string;
  text?: string;
}

export interface WebResearchResult {
  sources: WebSource[];
  citations: string[];
  warnings: string[];
  error?: "web-unavailable";
}

export const WEB_MAX_RESULTS = 8;
export const WEB_MAX_PAGES = 5;
export const WEB_MAX_BYTES_PER_PAGE = 120_000;
export const WEB_TIMEOUT_MS = 20_000;
const EXCERPT_CHARS = 800;

export function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.isFinite(value) ? Number(value) : fallback;
  return Math.max(min, Math.min(Math.trunc(parsed), max));
}

/**
 * Strip the parts of a page that are not content, then normalise whitespace.
 *
 * Deliberately simple: this is evidence extraction, not a browser. A page whose
 * text survives only through JavaScript is reported as thin content, not fetched
 * with a browser.
 */
export function extractReadableText(html: string): string {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|pre|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function citationOf(source: WebSource): string {
  return `${source.url} — ${source.title} (sha256:${source.sha256.slice(0, 12)}…, fetched ${source.fetchedAt})`;
}

function truncateBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  const chars = Math.max(1, Math.floor(maxBytes / 2));
  return { text: text.slice(0, chars), truncated: true };
}

async function fetchSource(
  url: string,
  title: string,
  options: { maxBytes: number; timeoutMs: number; deps: { fetch?: WebFetchPort; now?: () => number }; warnings: string[] },
): Promise<WebSource | undefined> {
  if (!options.deps.fetch) {
    options.warnings.push(`no fetch provider is installed; could not read ${url}`);
    return undefined;
  }
  try {
    const response = await options.deps.fetch.fetch(url, { maxBytes: options.maxBytes, timeoutMs: options.timeoutMs });
    if (!response.ok) {
      options.warnings.push(`${url} returned ${response.status}${response.error ? ` (${response.error})` : ""}`);
      return undefined;
    }
    const extracted = extractReadableText(response.text);
    const capped = truncateBytes(extracted, options.maxBytes);
    if (capped.truncated) options.warnings.push(`${url} was truncated to ${options.maxBytes} bytes`);
    const now = options.deps.now ? options.deps.now() : Date.now();
    return {
      url: response.finalUrl ?? url,
      title,
      fetchedAt: new Date(now).toISOString(),
      sha256: digestOf(capped.text),
      excerpt: capped.text.slice(0, EXCERPT_CHARS),
      text: capped.text,
    };
  } catch (error: any) {
    options.warnings.push(`${url} failed: ${error?.message ?? error}`);
    return undefined;
  }
}

/**
 * Search (or use the given URLs), fetch a bounded number of pages, and return
 * cited sources. `urls` bypasses discovery entirely.
 */
export async function webResearch(
  input: WebResearchInput,
  deps: { search?: WebSearchPort; fetch?: WebFetchPort; now?: () => number; timeoutMs?: number },
): Promise<WebResearchResult> {
  const maxResults = clamp(input.maxResults, 5, 1, WEB_MAX_RESULTS);
  const maxPages = clamp(input.maxPages, 3, 1, WEB_MAX_PAGES);
  const maxBytes = clamp(input.maxBytesPerPage, 40_000, 1_000, WEB_MAX_BYTES_PER_PAGE);
  const warnings: string[] = [];

  const urls: string[] = [];
  const titles = new Map<string, string>();
  for (const url of input.urls ?? []) {
    const clean = String(url ?? "").trim();
    if (clean && !urls.includes(clean)) urls.push(clean);
  }

  if (!urls.length) {
    if (!deps.search) {
      return {
        sources: [],
        citations: [],
        warnings: ["no web search provider is installed (google_search / web_search)"],
        error: "web-unavailable",
      };
    }
    try {
      const hits = await deps.search.search(String(input.query ?? ""), { limit: maxResults, recency: input.recency });
      for (const hit of hits.slice(0, maxResults)) {
        const url = String(hit?.url ?? "").trim();
        if (!url || urls.includes(url)) continue;
        urls.push(url);
        titles.set(url, String(hit?.title ?? url));
      }
      if (!urls.length) warnings.push("the search provider returned no URLs");
    } catch (error: any) {
      warnings.push(`web search failed: ${error?.message ?? error}`);
    }
  }

  if (!urls.length) return { sources: [], citations: [], warnings };

  const pages = urls.slice(0, maxPages);
  if (urls.length > pages.length) warnings.push(`only the first ${pages.length} of ${urls.length} URLs were fetched`);

  const sources: WebSource[] = [];
  for (const url of pages) {
    const source = await fetchSource(url, titles.get(url) ?? url, {
      maxBytes,
      timeoutMs: deps.timeoutMs ?? WEB_TIMEOUT_MS,
      deps,
      warnings,
    });
    if (source) sources.push(source);
  }

  return { sources, citations: sources.map(citationOf), warnings };
}

/** One URL, same contract as a single `web_research` source. */
export async function webFetch(
  input: { url: string; maxBytes?: number },
  deps: { fetch?: WebFetchPort; now?: () => number; timeoutMs?: number },
): Promise<{ source?: WebSource; warnings: string[] }> {
  const warnings: string[] = [];
  const url = String(input.url ?? "").trim();
  if (!url) return { warnings: ["web_fetch needs a URL"] };
  const maxBytes = clamp(input.maxBytes, 40_000, 1_000, WEB_MAX_BYTES_PER_PAGE);
  const source = await fetchSource(url, url, {
    maxBytes,
    timeoutMs: deps.timeoutMs ?? WEB_TIMEOUT_MS,
    deps,
    warnings,
  });
  return { ...(source ? { source } : {}), warnings };
}
