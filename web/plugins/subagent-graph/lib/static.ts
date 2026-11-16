// Graph asset policy around @fastify/static. No manual MIME table, file
// streaming or response completion lives in the runtime anymore.
import staticFiles from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { extname, join, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { assetPathname, BUILT_ASSET_OPTIONS, isStaticMiss } from "../../../../lib/built-asset-policy.ts";

// This standalone host owns its I/O and never imports the primary runtime.
async function assertStaticContainment(root: string, file: string): Promise<void> {
  try {
    const [boundary, target] = await Promise.all([realpath(root), realpath(file)]);
    if (target === boundary || target.startsWith(boundary + sep)) return;
  } catch {
    // Rebuilds may replace files between selection and this policy check.
  }
  throw Object.assign(new Error("static file unavailable or outside root"), { statusCode: 404 });
}

const ASSET_EXTENSIONS = new Set([
  ".html", ".js", ".mjs", ".css", ".json", ".map", ".svg", ".png", ".jpg",
  ".jpeg", ".webp", ".woff", ".woff2", ".wasm", ".txt", ".ico",
]);

// Graphviz's WASM compilation needs wasm-unsafe-eval, not unsafe-eval.
const HTML_CSP = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self' data:", "connect-src 'self'", "worker-src 'self' blob:",
  "child-src 'self' blob:", "object-src 'none'", "base-uri 'none'",
  "form-action 'none'", "frame-ancestors 'none'",
].join("; ");

const FALLBACK_INDEX = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Pi subagent-graph</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;color:#ddd;background:#15171c}a{color:#8ab4f8}</style>
</head><body><h1>Pi subagent-graph</h1>
<p>The subagent-graph API is running, but no UI bundle was found in <code>web/plugins/subagent-graph/app/</code>.</p>
<p>Build the UI (or place <code>web/plugins/subagent-graph/app/index.html</code>) and reload.</p>
<p>API: <a href="/api/sessions">/api/sessions</a></p>
</body></html>`;

function graphNotFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const path = assetPathname(request.url);
  if (path?.startsWith("/api/")) {
    return reply.code(404).header("cache-control", "no-store").send({ error: "not found" });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return reply.code(405).header("cache-control", "no-store").send({ error: "method not allowed" });
  }
  if (path === "/" || path === "/index.html") {
    return reply.code(200).type("text/html; charset=utf-8").header("content-security-policy", HTML_CSP)
      .header("cache-control", "no-store").send(FALLBACK_INDEX);
  }
  return reply.code(404).type("text/plain; charset=utf-8").header("cache-control", "no-store").send("not found");
}

/** Layout/type policy only. Prefix registrations perform the URL-to-root map. */
function graphAssetAllowed(request: FastifyRequest, candidateRoot: string, root: string): boolean {
  const path = assetPathname(request.url);
  if (path === null || path.includes("//")) return false;
  if (path === "/" || path === "/index.html") return true;
  if (!ASSET_EXTENSIONS.has(extname(path).toLowerCase())) return false;
  if (path.startsWith("/assets/") || path.startsWith("/dist/")) return !path.endsWith("/");
  // dist is an index fallback, not a second source for arbitrary root filenames.
  return resolve(candidateRoot) === resolve(root) && /^\/[A-Za-z0-9][A-Za-z0-9._-]*\.(css|html|svg|ico|js|mjs|map|wasm|woff2|png|webp)$/.test(path);
}

export async function registerGraphStatic(app: FastifyInstance, root: string): Promise<void> {
  await app.register(async scope => {
    scope.setNotFoundHandler(graphNotFound);
    scope.setErrorHandler((error, request, reply) => {
      if (isStaticMiss(error)) return graphNotFound(request, reply);
      request.log.error({ err: error }, "graph static delivery failed");
      return reply.code(500).header("cache-control", "no-store").send({ error: "internal error" });
    });
    scope.addHook("onRequest", async (request, reply) => {
      const path = assetPathname(request.url);
      if (path === null || path.startsWith("/api/")) return graphNotFound(request, reply);
    });
    for (const [index, prefix] of ["/", "/assets/", "/dist/"].entries()) {
      await scope.register(staticFiles, {
        ...BUILT_ASSET_OPTIONS,
        root: index === 0 ? [root, join(root, "dist")] : join(root, "dist"),
        prefix,
        index: index === 0 ? "index.html" : false,
        decorateReply: index === 0,
        allowedPath: (_path, candidateRoot, request) => graphAssetAllowed(request, candidateRoot ?? root, root),
        onFile: file => assertStaticContainment(root, file),
        setHeaders: (reply, file) => {
          reply.header("cache-control", "no-cache");
          if (extname(file).toLowerCase() === ".html") reply.header("content-security-policy", HTML_CSP);
        },
      });
    }
  });
}
