import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "./main.ts";
import { createGraphApp } from "../../plugins/subagent-graph/lib/app.ts";

const SHELL = "<!doctype html><html><head></head><body>shell</body></html>";

test("primary static delivery preserves SPA, build identity, methods and cache policy", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-static-primary-"));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "index.html"), SHELL);
  await writeFile(join(root, "nested", "index.html"), "not the SPA shell");
  await writeFile(join(root, "build.json"), JSON.stringify({ buildId: "first" }));
  await writeFile(join(root, "app.js"), "first bundle");
  await writeFile(join(root, "graph.wasm"), Buffer.from([0, 97, 115, 109]));
  await writeFile(join(root, "font.woff2"), "font");
  await writeFile(join(root, "data.bcmap"), "opaque bytes");
  await writeFile(join(root, ".secret.js"), "secret");
  const server = await startWebServer({ port: 0, host: "127.0.0.1", clientDist: root });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await t.test("shell and every extensionless SPA path are stamped with the correct length", async () => {
      for (const path of ["/", "/index.html", "/plugins/todo", "/plugins/core.plugin-manager", "/nested/", "/nested"]) {
        const response = await fetch(base + path);
        assert.equal(response.status, 200, path);
        assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(response.headers.get("content-length"), String(bytes.length));
        assert.match(bytes.toString(), /pi-web-build.*first/);
        assert.match(bytes.toString(), /<body>shell/);
      }
    });
    await t.test("assets have native MIME types but no new validators/ranges/cache behaviour", async () => {
      for (const [path, mime] of [["app.js", "application/javascript"], ["graph.wasm", "application/wasm"], ["font.woff2", "font/woff2"], ["data.bcmap", "application/octet-stream"]]) {
        const response = await fetch(`${base}/${path}`, { headers: { range: "bytes=0-1", "if-none-match": "*" } });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type")!, new RegExp(`^${mime}`));
        assert.equal(response.headers.get("cache-control"), "no-cache");
        for (const name of ["etag", "last-modified", "content-range", "accept-ranges", "location", "content-security-policy"]) {
          assert.equal(response.headers.get(name), null, name);
        }
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        await response.arrayBuffer();
      }
    });
    await t.test("API misses never become SPA HTML and unsupported static methods are 405", async () => {
      for (const method of ["GET", "POST", "HEAD"]) {
        const response = await fetch(`${base}/api/unknown`, { method });
        assert.equal(response.status, 404);
        assert.match(response.headers.get("content-type")!, /application\/json/);
        await response.arrayBuffer();
      }
      const missingAsset = await fetch(`${base}/plugins/core.plugin-manager.js`);
      assert.equal(missingAsset.status, 404);
      assert.deepEqual(await missingAsset.json(), { error: "not found" });
      for (const method of ["POST", "HEAD"]) {
        const response = await fetch(`${base}/app.js`, { method });
        assert.equal(response.status, 405);
        await response.arrayBuffer();
      }
      const hidden = await fetch(`${base}/.secret.js`);
      assert.equal(hidden.status, 404);
      await hidden.arrayBuffer();
    });
    await t.test("a rebuild replaces bytes and build stamps without restarting", async () => {
      await writeFile(join(root, "build.json"), JSON.stringify({ buildId: "second" }));
      await writeFile(join(root, "app.js"), "second bundle");
      assert.equal(await (await fetch(`${base}/app.js`)).text(), "second bundle");
      assert.match(await (await fetch(`${base}/plugins/todo`)).text(), /pi-web-build.*second/);
    });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("missing primary builds return 404 without a recursive SPA fallback", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-static-missing-"));
  const server = await startWebServer({ port: 0, host: "127.0.0.1", clientDist: join(root, "not-built") });
  try {
    for (const path of ["/", "/plugins/todo", "/app.js"]) {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "not found" });
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("graph static prefixes retain index precedence, type allowlists, CSP and HEAD", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-static-graph-"));
  await mkdir(join(root, "dist", "nested"), { recursive: true });
  await writeFile(join(root, "index.html"), "root index");
  await writeFile(join(root, "dist", "index.html"), "dist index");
  await writeFile(join(root, "dist", "app.js"), "graph bundle");
  await writeFile(join(root, "dist", "nested", "index.html"), "no directory indexes");
  await writeFile(join(root, "dist", "private.ts"), "private");
  await writeFile(join(root, "dist", ".hidden.js"), "private");
  const app = await createGraphApp({ staticRoot: root, guard: () => true });
  try {
    await t.test("root index wins, then dist/index, then the local placeholder", async () => {
      assert.equal((await app.inject("/")).body, "root index");
      await unlink(join(root, "index.html"));
      const dist = await app.inject("/");
      assert.equal(dist.statusCode, 200);
      assert.equal(dist.body, "dist index");
      assert.match(String(dist.headers["content-security-policy"]), /wasm-unsafe-eval/);
      assert.equal(dist.headers["cache-control"], "no-cache");
      const head = await app.inject({ method: "HEAD", url: "/" });
      assert.equal(head.statusCode, 200);
      assert.equal(head.body, "");
      assert.equal(head.headers["content-length"], String(Buffer.byteLength("dist index")));
      await unlink(join(root, "dist", "index.html"));
      const fallback = await app.inject("/");
      assert.equal(fallback.statusCode, 200);
      assert.match(fallback.body, /no UI bundle/);
      assert.equal(fallback.headers["cache-control"], "no-store");
    });
    await t.test("prefix aliases serve identical assets without broadening the allowed surface", async () => {
      for (const path of ["/assets/app.js", "/dist/app.js"]) {
        const response = await app.inject(path);
        assert.equal(response.statusCode, 200);
        assert.equal(response.body, "graph bundle");
        assert.equal(response.headers.etag, undefined);
        assert.equal(response.headers["last-modified"], undefined);
        assert.equal(response.headers["cache-control"], "no-cache");
        assert.equal(response.headers["content-security-policy"], undefined);
      }
      for (const path of ["/app.js", "/assets/private.ts", "/assets/.hidden.js", "/assets/nested/", "/assets/..%2findex.html"]) {
        assert.equal((await app.inject(path)).statusCode, 404, path);
      }
      const api = await app.inject("/api/unknown");
      assert.equal(api.statusCode, 404);
      assert.deepEqual(api.json(), { error: "not found" });
    });
    await t.test("a symlink to an out-of-root file is denied", async () => {
      const outside = await mkdtemp(join(tmpdir(), "pi-static-outside-"));
      try {
        await writeFile(join(outside, "secret.js"), "secret");
        await symlink(join(outside, "secret.js"), join(root, "dist", "escape.js"));
        assert.equal((await app.inject("/assets/escape.js")).statusCode, 404);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
