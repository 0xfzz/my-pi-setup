import test from "node:test";
import assert from "node:assert/strict";
import { registerDiscoveredBrowserHalves } from "./discovered-browser-halves.ts";
import type { BrowserRuntime } from "./browser-host.ts";
import { registerBrowserHalfFromUrl } from "./browser-host.ts";

const runtime = {} as BrowserRuntime;

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    version: "1.0.0",
    source: "package",
    sourcePath: "./dist/browser.js",
    capabilities: ["ui.panel"],
    trust: "trusted",
    url: `/api/browser-halves/${id}/main.js`,
    hash: "sha256:abc",
    ...overrides,
  };
}

test("discovered halves are merged, validated and hash-bound without replacing static halves", async () => {
  const calls: Array<{ id: string; expectedHash?: string; sourcePath: string }> = [];
  const register: typeof registerBrowserHalfFromUrl = async (_runtime, info) => {
    calls.push({ id: info.id, expectedHash: info.expectedHash, sourcePath: info.sourcePath });
    if (info.id === "acme.fails") throw new Error("boom");
  };
  const fetchHalves = async () => ({
    ok: true as const,
    data: {
      halves: [
        row("acme.panel"),
        row("files"),
        row("acme.declarative", { trust: "declarative" }),
        row("acme.fails"),
        { id: "acme.broken" },
      ],
    },
  });

  const report = await registerDiscoveredBrowserHalves(runtime, {
    fetchHalves,
    register,
    staticIds: ["files"],
  });

  assert.deepEqual(report.registered, ["acme.panel"]);
  assert.deepEqual(report.skipped, ["files", "acme.declarative"]);
  assert.equal(report.errors.length, 2);
  assert.ok(report.errors.some((error) => error.includes("acme.fails: boom")));
  assert.ok(report.errors.some((error) => error.includes("malformed")));
  assert.deepEqual(calls[0], {
    id: "acme.panel",
    expectedHash: "sha256:abc",
    sourcePath: "./dist/browser.js",
  });
});

test("a metadata failure is reported without throwing or registering anything", async () => {
  const fetchHalves = async () => ({ ok: false as const, error: new Error("offline") });
  const report = await registerDiscoveredBrowserHalves(runtime, { fetchHalves });
  assert.deepEqual(report, {
    registered: [],
    skipped: [],
    errors: ["metadata request failed: offline"],
  });
});
