import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  PAGE_CACHE_MAX_BYTES,
  pageCacheRelativePath,
  readPageCache,
  writePageCache,
} from "../../lib/orchestrator/page-cache.ts";
import { SCRATCH_CACHE_TTL_MS } from "../../lib/orchestrator/scratch.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orch-page-cache-"));
  return { root, detach: () => rm(root, { recursive: true, force: true }) };
}

test("a page round-trips through the scratch web cache", async () => {
  const h = await fixture();
  try {
    assert.equal(writePageCache(h.root, "https://example.test/a", "hello"), true);
    const hit = readPageCache(h.root, "https://example.test/a");
    assert.equal(hit?.text, "hello");
    assert.equal(hit?.url, "https://example.test/a");
  } finally {
    await h.detach();
  }
});

test("an expired entry is a miss, so the caller re-fetches", async () => {
  const h = await fixture();
  try {
    const now = 1_000_000;
    writePageCache(h.root, "https://example.test/a", "hello", { now });
    assert.equal(readPageCache(h.root, "https://example.test/a", { now: now + SCRATCH_CACHE_TTL_MS + 1 }), undefined);
    assert.equal(readPageCache(h.root, "https://example.test/a", { now: now + 1 })?.text, "hello");
  } finally {
    await h.detach();
  }
});

test("a tampered entry never answers for another URL", async () => {
  const h = await fixture();
  try {
    writePageCache(h.root, "https://example.test/a", "hello");
    const path = join(h.root, pageCacheRelativePath("https://example.test/a"));
    await writeFile(path, JSON.stringify({ url: "https://evil.test/x", text: "poison", fetchedAt: Date.now() }), "utf8");
    assert.equal(readPageCache(h.root, "https://example.test/a"), undefined);
  } finally {
    await h.detach();
  }
});

test("an oversized page is not cached", async () => {
  const h = await fixture();
  try {
    assert.equal(writePageCache(h.root, "https://example.test/big", "x".repeat(PAGE_CACHE_MAX_BYTES + 1)), false);
    assert.equal(readPageCache(h.root, "https://example.test/big"), undefined);
  } finally {
    await h.detach();
  }
});

test("the cache lives under the scratch root and nowhere else", async () => {
  const h = await fixture();
  try {
    writePageCache(h.root, "https://example.test/a", "hello");
    const relative = pageCacheRelativePath("https://example.test/a");
    assert.match(relative, /^cache\/web\/[0-9a-f]{32}\.json$/);
    const raw = JSON.parse(await readFile(join(h.root, relative), "utf8"));
    assert.equal(raw.url, "https://example.test/a");
  } finally {
    await h.detach();
  }
});
