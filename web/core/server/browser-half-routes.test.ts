import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import {
  BROWSER_HALF_MAX_BYTES,
  BROWSER_HALVES_API,
  browserHalfAssetUrl,
  type BrowserHalfSource,
} from "../shared/browser-halves.ts";
import { registerBrowserHalfRoutes, type BrowserHalfHost } from "./browser-half-routes.ts";

const SOURCE = "export function mount(el) { return () => undefined; }\n";

function tempHost(): { dir: string; half: BrowserHalfSource; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "browser-half-routes-"));
  writeFileSync(join(dir, "browser.js"), SOURCE);
  return {
    dir,
    half: {
      id: "acme.panel",
      version: "1.0.0",
      source: "package",
      dir,
      sourcePath: "./browser.js",
      capabilities: ["ui.panel"],
      trust: "trusted",
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function appFor(half: BrowserHalfSource | undefined) {
  const app = Fastify();
  const host: BrowserHalfHost = { browserHalves: half === undefined ? [] : [half] };
  await registerBrowserHalfRoutes(app, host);
  await app.ready();
  return app;
}

test("metadata hides the plugin directory and publishes the exact source hash", async () => {
  const fixture = tempHost();
  const app = await appFor(fixture.half);
  try {
    const response = await app.inject({ url: BROWSER_HALVES_API });
    assert.equal(response.statusCode, 200);
    const rows = response.json().halves;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "acme.panel");
    assert.equal(rows[0].url, browserHalfAssetUrl("acme.panel"));
    assert.match(rows[0].hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(rows[0].dir, undefined);
    assert.equal(rows[0].sourcePath, "./browser.js");
  } finally {
    await app.close();
    fixture.cleanup();
  }
});

test("the asset route serves a contained JS module with no-store headers", async () => {
  const fixture = tempHost();
  const app = await appFor(fixture.half);
  try {
    const response = await app.inject({ url: browserHalfAssetUrl("acme.panel") });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, SOURCE);
    assert.match(response.headers["content-type"] ?? "", /^text\/javascript/);
    assert.equal(response.headers["cache-control"], "no-store");
  } finally {
    await app.close();
    fixture.cleanup();
  }
});

test("traversal, symlink escape, oversize and unknown ids are refused", async () => {
  const fixture = tempHost();
  try {
    const outside = join(tmpdir(), `browser-half-outside-${Date.now()}.js`);
    writeFileSync(outside, SOURCE);
    symlinkSync(outside, join(fixture.dir, "escape.js"));

    for (const sourcePath of ["../outside.js", "./escape.js", "browser.js", "./missing.mjs"]) {
      const app = await appFor({ ...fixture.half, sourcePath });
      try {
        const metadata = await app.inject({ url: BROWSER_HALVES_API });
        assert.deepEqual(metadata.json().halves, [], `metadata hides ${sourcePath}`);
        const asset = await app.inject({ url: browserHalfAssetUrl("acme.panel") });
        assert.equal(asset.statusCode, 404, `asset refuses ${sourcePath}`);
      } finally {
        await app.close();
      }
    }

    writeFileSync(join(fixture.dir, "browser.js"), "x".repeat(BROWSER_HALF_MAX_BYTES + 1));
    const oversize = await appFor(fixture.half);
    try {
      const asset = await oversize.inject({ url: browserHalfAssetUrl("acme.panel") });
      assert.equal(asset.statusCode, 404);
    } finally {
      await oversize.close();
    }

    const empty = await appFor(undefined);
    try {
      assert.equal((await empty.inject({ url: browserHalfAssetUrl("acme.unknown") })).statusCode, 404);
      assert.equal((await empty.inject({ url: `${BROWSER_HALVES_API}/BAD/main.js` })).statusCode, 400);
    } finally {
      await empty.close();
    }
  } finally {
    fixture.cleanup();
  }
});
