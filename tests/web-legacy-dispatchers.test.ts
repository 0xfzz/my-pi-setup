/**
 * Removal audit (PRD §12): no production HTTP dispatcher survives under `web/`.
 *
 * This is a named-symbol ratchet, not a blanket ban on `node:http` or
 * `JSON.stringify`. Tests, build output, e2e drivers and the deliberate
 * compatibility seams named below are excluded; everything else must not
 * reintroduce the deleted handwritten infrastructure.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");

function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "app") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) productionSources(full, out);
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry.name) && !/\.test\.(ts|mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const FILES = productionSources(join(ROOT, "web")).map(file => ({
  path: relative(ROOT, file),
  // Strip comments so a historical mention (e.g. "like the old readSmallJson")
  // is not mistaken for a reintroduced mechanism; `http://` survives because a
  // line comment needs leading whitespace.
  text: readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1"),
}));

function offenders(pattern: RegExp): string[] {
  return FILES.filter(file => pattern.test(file.text)).map(file => file.path);
}

test("no production file reintroduces a deleted handwritten dispatcher symbol", () => {
  for (const symbol of [
    /\bmatchSegments\b/, /\bsplitRequestPath\b/, /\bAPI_ROUTES\b/, /\bhandleApi\b/, /\bmatchRoute\b/,
    /\breadJsonBody\b/, /\breadSmallJson\b/, /\bsendRawJson\b/, /\bparseCookies\b/, /\bMIME_TYPES\b/,
    /\bresolveStaticPath\b/, /\bcloseAllConnections\b/, /\.writeHead\(/,
  ]) {
    assert.deepEqual(offenders(symbol), [], `forbidden legacy symbol ${String(symbol)}`);
  }
});

test("raw Fastify reply ownership stays inside the documented exception seams", () => {
  // E2 legacy external-plugin adapter and its pointer from the plugin route.
  assert.deepEqual(offenders(/reply\.hijack\(\)/), ["web/core/server/legacy-plugin-transport.ts"]);
  // E5 shared SSE adapter / E2 legacy plugin transport / E6 auth revocation.
  assert.deepEqual(offenders(/reply\.raw/).sort(), [
    "web/core/http/sse.ts",
    "web/core/server/auth.ts",
    "web/core/server/legacy-plugin-transport.ts",
    "web/core/server/plugin-routes.ts",
  ]);
});

test("node:http types survive only in the auth policy/revocation seam", () => {
  assert.deepEqual(offenders(/from "node:http"/), ["web/core/server/auth.ts"]);
});
