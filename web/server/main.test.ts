import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { startWebServer, resolveStaticPath } from "./main.ts";

async function withServer(
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const handle = await startWebServer({ port: 0, host: "127.0.0.1" });
  try {
    await fn(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

test("health endpoint reports service identity", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    const body = (await res.json()) as { ok?: boolean; service?: string };
    assert.equal(body.ok, true);
    assert.equal(body.service, "pi-web-minimal");
  });
});

test("plugins registry endpoint serves the descriptor list", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/plugins`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      plugins?: Array<{ id: string; title: string; surfaces: unknown[] }>;
    };
    assert.ok(Array.isArray(body.plugins), "plugins must be an array");
    const ids = (body.plugins ?? []).map((p) => p.id);
    for (const expected of [
      "cache-stats",
      "todo",
      "artifacts",
      "subagent-checkpoints",
      "subagent-monitor",
      "modes",
      "bubbly-spinner",
    ]) {
      assert.ok(ids.includes(expected), `plugin ${expected} must be registered`);
    }
  });
});

test("static root serves the built client", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await res.text();
    assert.match(html, /<div id="root">/);
    assert.match(html, /app\.js/);
  });
});

test("static serving returns 404 for unknown assets", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/no-such-asset.js`);
    assert.equal(res.status, 404);
  });
});

test("non-GET requests are rejected with 405", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/plugins`, { method: "POST" });
    assert.equal(res.status, 405);
  });
});

test("resolveStaticPath rejects traversal and accepts real paths", () => {
  const root = resolve("/tmp/some-dist");
  assert.equal(resolveStaticPath(root, "/"), `${root}/index.html`);
  assert.equal(resolveStaticPath(root, "/app.js"), `${root}/app.js`);
  assert.equal(resolveStaticPath(root, "/..%2f..%2fetc%2fpasswd"), null);
  assert.equal(resolveStaticPath(root, "/%2e%2e/secret"), null);
  assert.equal(resolveStaticPath(root, "/\0etc"), null);
  assert.equal(resolveStaticPath(root, "/a/../../etc/passwd"), null);
});
