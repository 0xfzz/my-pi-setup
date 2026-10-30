import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  digestOf,
  extractReadableText,
  webResearch,
  type WebFetchPort,
  type WebSearchPort,
} from "../../lib/orchestrator/web-research.ts";

const html = `<!doctype html><html><head><style>body{color:red}</style>
<script>evil()</script></head><body><h1>Retry policy</h1>
<p>Use exponential backoff &amp; jitter.</p></body></html>`;

const fetchPort = (pages: Record<string, string>): WebFetchPort => ({
  async fetch(url: string, options) {
    if (!(url in pages)) return { ok: false, status: 404, text: "", error: "not found" };
    const text = pages[url]!;
    return { ok: true, status: 200, text: text.slice(0, options.maxBytes), contentType: "text/html" };
  },
});

const searchPort = (hits: Array<{ url: string; title: string }>): WebSearchPort => ({
  async search() {
    return hits;
  },
});

test("a research call returns cited sources with digests and stripped text", async () => {
  const result = await webResearch(
    { query: "retry policy" },
    {
      search: searchPort([
        { url: "https://example.test/a", title: "Retry" },
        { url: "https://example.test/b", title: "Backoff" },
      ]),
      fetch: fetchPort({ "https://example.test/a": html, "https://example.test/b": "<p>Jitter</p>" }),
      now: () => Date.parse("2026-01-02T03:04:05Z"),
    },
  );

  assert.equal(result.sources.length, 2);
  assert.equal(result.citations.length, 2);
  assert.match(result.citations[0]!, /^https:\/\/example\.test\/a — Retry \(sha256:[0-9a-f]{12}…, fetched 2026-01-02T03:04:05\.000Z\)$/);
  const first = result.sources[0]!;
  assert.equal(first.sha256, digestOf(first.text!));
  assert.match(first.text!, /exponential backoff & jitter/);
  assert.doesNotMatch(first.text!, /evil\(\)|color:red/, "script and style never reach the reviewer");
  assert.ok(first.excerpt.length <= 800);
});

test("explicit URLs bypass discovery entirely", async () => {
  let searched = false;
  const result = await webResearch(
    { query: "ignored", urls: ["https://example.test/a"] },
    {
      search: { async search() { searched = true; return []; } },
      fetch: fetchPort({ "https://example.test/a": "<p>evidence</p>" }),
    },
  );
  assert.equal(searched, false, "a provider failure cannot block a pinned URL");
  assert.equal(result.sources.length, 1);
  assert.match(result.sources[0]!.text!, /evidence/);
});

test("without a provider the call is a capability error, not an empty result", async () => {
  const result = await webResearch({ query: "anything" }, { fetch: fetchPort({}) });
  assert.equal(result.error, "web-unavailable");
  assert.equal(result.sources.length, 0);
  assert.match(result.warnings.join(" "), /no web search provider/);
});

test("a failed fetch becomes a warning and does not take down the batch", async () => {
  const result = await webResearch(
    { query: "q" },
    {
      search: searchPort([{ url: "https://example.test/missing", title: "Missing" }, { url: "https://example.test/a", title: "Retry" }]),
      fetch: fetchPort({ "https://example.test/a": "<p>ok</p>" }),
    },
  );
  assert.equal(result.sources.length, 1);
  assert.match(result.warnings.join(" "), /missing returned 404/);
});

test("the page cap is reported, never silently applied", async () => {
  const result = await webResearch(
    { query: "q", maxPages: 1 },
    {
      search: searchPort([
        { url: "https://example.test/a", title: "A" },
        { url: "https://example.test/b", title: "B" },
      ]),
      fetch: fetchPort({ "https://example.test/a": "<p>a</p>", "https://example.test/b": "<p>b</p>" }),
    },
  );
  assert.equal(result.sources.length, 1);
  assert.match(result.warnings.join(" "), /only the first 1 of 2 URLs/);
});

test("readable text keeps content and drops markup", () => {
  const text = extractReadableText("<div>one</div><p>two &amp; three</p><script>x()</script>");
  assert.match(text, /one\s+two & three/);
  assert.doesNotMatch(text, /x\(\)/);
});

test("the web module imports no filesystem module (scratch is the caller's job)", () => {
  const source = readFileSync(join(import.meta.dirname, "../../lib/orchestrator/web-research.ts"), "utf8");
  assert.doesNotMatch(source, /from "node:fs/);
});
