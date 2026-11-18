import test from "node:test";
import assert from "node:assert/strict";
import { registerDiscoveredBrowserHalves } from "./discovered-browser-halves.ts";
import type { BrowserHalfDefinition, BrowserRuntime, BrowserHalfSourceInfo } from "./browser-host.ts";

function prepared(id: string): BrowserHalfDefinition {
  return {
    id,
    version: "1.0.0",
    sourcePath: "./dist/browser.js",
    capabilities: ["ui.panel"],
    hash: "sha256:abc",
    module: { mount: () => () => undefined },
  };
}

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

test("discovered halves are prepared in parallel, validated and registered in one batch", async () => {
  const preparedIds: string[] = [];
  const batches: Array<readonly string[]> = [];
  let active = 0;
  let peak = 0;
  const prepare = async (info: BrowserHalfSourceInfo) => {
    preparedIds.push(info.id);
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active -= 1;
    if (info.id === "acme.fails") throw new Error("boom");
    return prepared(info.id);
  };

  const report = await registerDiscoveredBrowserHalves({} as BrowserRuntime, {
    fetchHalves: async () => ({
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
    }),
    prepare,
    addDefinitions: async (definitions) => { batches.push(definitions.map((item) => item.id)); },
    staticIds: ["files"],
  });

  assert.deepEqual(report.registered, ["acme.panel"]);
  assert.deepEqual(report.skipped, ["files", "acme.declarative"]);
  assert.equal(report.errors.length, 2);
  assert.ok(report.errors.some((error) => error.includes("acme.fails: boom")));
  assert.ok(report.errors.some((error) => error.includes("malformed")));
  assert.deepEqual(preparedIds, ["acme.panel", "acme.fails"]);
  assert.equal(peak, 2, "independent bundles must be fetched concurrently");
  assert.deepEqual(batches, [["acme.panel"]], "one batched registration, not one per half");
});

test("a batch registration failure leaves no half reported as registered", async () => {
  const report = await registerDiscoveredBrowserHalves({} as BrowserRuntime, {
    fetchHalves: async () => ({ ok: true as const, data: { halves: [row("acme.panel")] } }),
    prepare: async (info) => prepared(info.id),
    addDefinitions: async () => { throw new Error("server down"); },
  });

  assert.deepEqual(report.registered, []);
  assert.deepEqual(report.errors, ["registration failed: server down"]);
});

test("a metadata failure is reported without throwing or registering anything", async () => {
  const fetchHalves = async () => ({ ok: false as const, error: new Error("offline") });
  const report = await registerDiscoveredBrowserHalves({} as BrowserRuntime, { fetchHalves });
  assert.deepEqual(report, {
    registered: [],
    skipped: [],
    errors: ["metadata request failed: offline"],
  });
});
