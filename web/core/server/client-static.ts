// Primary-host build delivery: the library ships files, this module owns the
// extensionless SPA fallback and the HTML build-identity transform.
import staticFiles from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { join, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { servedClientBuild, stampBuildId } from "./client-build.ts";
import { assetPathname, BUILT_ASSET_OPTIONS, isSpaFallbackPath, isStaticMiss } from "../../../lib/built-asset-policy.ts";

// onFile must reject to veto the selected build output. This host owns I/O;
// the shared policy module remains pure and independent of either server.
function createContainmentCheck(root: string): (file: string) => Promise<void> {
  let boundary: string | null | undefined;
  const rootBoundary = async (): Promise<string | null> => {
    // An absent root is retried: a rebuild can create it while the app lives.
    if (boundary === undefined || boundary === null) boundary = await realpath(root).catch(() => null);
    return boundary;
  };
  return async (file: string): Promise<void> => {
    try {
      const [base, target] = await Promise.all([rootBoundary(), realpath(file)]);
      if (base !== null && (target === base || target.startsWith(base + sep))) return;
    } catch {
      // A selected file disappearing during a rebuild is an ordinary miss.
    }
    throw Object.assign(new Error("static file unavailable or outside root"), { statusCode: 404 });
  };
}

function apiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).header("cache-control", "no-store").send({ error: "not found" });
}

async function stampShell(reply: FastifyReply, payload: unknown): Promise<unknown> {
  if (!(payload instanceof Readable)) return payload;
  if (!String(reply.getHeader("content-type")).startsWith("text/html")) return payload;
  const build = servedClientBuild();
  if (build === null) return payload;
  const chunks: Buffer[] = [];
  for await (const chunk of payload) chunks.push(Buffer.from(chunk));
  const body = Buffer.from(stampBuildId(Buffer.concat(chunks).toString("utf8"), build.buildId));
  // The library's original length describes the unstamped on-disk shell.
  reply.header("content-length", body.length);
  return body;
}

async function hasShell(root: string): Promise<boolean> {
  try {
    return (await stat(join(root, "index.html"))).isFile();
  } catch {
    return false;
  }
}

export async function registerClientStatic(app: FastifyInstance, root: string): Promise<void> {
  const assertStaticContainment = createContainmentCheck(root);
  await app.register(async scope => {
    const fallbackAttempted = new WeakSet<FastifyRequest>();
    scope.addHook("onRequest", async (request, reply) => {
      const path = assetPathname(request.url);
      if (path === null || apiPath(path)) return notFound(reply);
      // @fastify/static explicitly registers HEAD, independent of Fastify's
      // exposeHeadRoutes flag. This host's historic contract is GET-only.
      if (request.method !== "GET") {
        return reply.code(405).header("cache-control", "no-store").send({ error: "method not allowed" });
      }
    });
    scope.addHook("onSend", async (_request, reply, payload) => stampShell(reply, payload));
    scope.setNotFoundHandler(async (request, reply) => {
      const path = assetPathname(request.url);
      if (path === null || apiPath(path)) return notFound(reply);
      if (request.method !== "GET") {
        return reply.code(405).header("cache-control", "no-store").send({ error: "method not allowed" });
      }
      // A failed fallback calls notFound again; never recurse on a missing index.
      if (isSpaFallbackPath(path) && !fallbackAttempted.has(request) && await hasShell(root)) {
        fallbackAttempted.add(request);
        return reply.code(200).sendFile("index.html");
      }
      return notFound(reply);
    });
    scope.setErrorHandler((error, request, reply) => {
      if (isStaticMiss(error)) return reply.callNotFound();
      request.log.error({ err: error }, "static delivery failed");
      return reply.code(500).header("cache-control", "no-store").send({ error: "internal error" });
    });
    scope.get("/", async (_request, reply) => reply.sendFile("index.html"));
    await scope.register(staticFiles, {
      ...BUILT_ASSET_OPTIONS,
      root,
      index: false, // Only / falls back to index; nested directories are SPA paths.
      allowedPath: (_path, _root, request) => assetPathname(request.url) !== null,
      onFile: assertStaticContainment,
      setHeaders: reply => { reply.header("cache-control", "no-cache"); },
    });
  });
}
