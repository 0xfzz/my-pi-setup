/** Authenticated delivery of externally built browser-half bundles. */
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import type { WebPluginDescriptor } from "../plugin-contracts/descriptor.ts";
import type { PluginHost } from "../plugin-contracts/kernel/host.ts";
import { PLUGIN_ID_PATTERN } from "../plugin-contracts/kernel/manifest.ts";
import {
  BROWSER_HALF_MAX_BYTES,
  BROWSER_HALVES_API,
  browserHalfAssetUrl,
  type BrowserHalfMetadata,
  type BrowserHalfSource,
} from "../shared/browser-halves.ts";
import { getPluginHost } from "./plugin-host.ts";

const JS_MIME = "text/javascript; charset=utf-8";

function sha256(source: string): string {
  return `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
}

export type BrowserHalfHost = Pick<PluginHost<WebPluginDescriptor>, "browserHalves">;

function sourceFor(id: string, host: BrowserHalfHost | null): BrowserHalfSource | undefined {
  return host?.browserHalves.find((half) => half.id === id);
}

function safeEntry(entry: string): boolean {
  return entry.startsWith("./") && !isAbsolute(entry) && !entry.includes("\\") && !entry.split("/").includes("..");
}

async function containedFile(half: BrowserHalfSource): Promise<string | undefined> {
  if (!safeEntry(half.sourcePath)) return undefined;
  const file = resolve(half.dir, half.sourcePath);
  let dir: string;
  let real: string;
  try {
    [dir, real] = await Promise.all([realpath(half.dir), realpath(file)]);
  } catch {
    return undefined;
  }
  if (real !== dir && !real.startsWith(`${dir}${sep}`)) return undefined;
  const info = await stat(real).catch(() => undefined);
  if (info === undefined || !info.isFile()) return undefined;
  if (!/\.(?:js|mjs)$/.test(real)) return undefined;
  if (info.size > BROWSER_HALF_MAX_BYTES) return undefined;
  return real;
}

export async function browserHalfMetadata(half: BrowserHalfSource): Promise<BrowserHalfMetadata | undefined> {
  const file = await containedFile(half);
  if (file === undefined) return undefined;
  const source = await readFile(file, "utf8");
  const { dir: _dir, ...publicHalf } = half;
  return { ...publicHalf, url: browserHalfAssetUrl(half.id), hash: sha256(source) };
}

export async function registerBrowserHalfRoutes(
  app: FastifyInstance,
  host: BrowserHalfHost | null = getPluginHost(),
): Promise<void> {
  app.get(BROWSER_HALVES_API, async () => {
    const halves = await Promise.all((host?.browserHalves ?? []).map(browserHalfMetadata));
    return { halves: halves.filter((half) => half !== undefined) };
  });

  app.get<{ Params: { id: string } }>(`${BROWSER_HALVES_API}/:id/main.js`, async (request, reply) => {
    const id = request.params.id;
    if (!PLUGIN_ID_PATTERN.test(id)) return reply.code(400).send({ error: "invalid browser half id" });
    const half = sourceFor(id, host);
    if (half === undefined) return reply.code(404).send({ error: "unknown browser half" });
    const file = await containedFile(half);
    if (file === undefined) return reply.code(404).send({ error: "browser half asset unavailable" });
    const source = await readFile(file, "utf8");
    return reply
      .code(200)
      .type(JS_MIME)
      .header("cache-control", "no-store")
      .send(source);
  });
}
