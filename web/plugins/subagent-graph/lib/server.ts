/**
 * server.ts — the shared, detached subagent-graph server.
 *
 * One server per OS user serves every Pi process and every browser tab. It is
 * deliberately independent of Pi: it imports only Node built-ins plus this
 * directory's protocol/validation, so it runs under Node 22 type stripping with
 * no host packages present. Nothing in this module starts a server, reads the
 * runtime directory, or opens a socket at import time; `startSubagentGraphServer`
 * does all of that.
 *
 * ── Trust model ────────────────────────────────────────────────────────────
 * Loopback is not authentication: any local process (or a hostile page that
 * guesses 127.0.0.1 ports) can reach the port. Two separate credentials exist:
 *
 *   - **Producer token** (private runtime file, 0600) authenticates Pi bridges.
 *     It is never serialized into browser responses or browser assets.
 *   - **Browser session** is a random HttpOnly SameSite=Strict cookie minted by
 *     `/bootstrap?token=<one-shot-ish bootstrap token>` and redirect to `/`.
 *     The bootstrap token is what the user is shown; it is not the producer token.
 *
 * Every request additionally requires a loopback `Host` header (DNS-rebinding
 * defense) and, when present, a same-origin `Origin`. Only read-only GET APIs are
 * exposed to browsers; the only mutations are authenticated producer transports.
 *
 * ── State model ────────────────────────────────────────────────────────────
 * Per session id the server holds the latest sanitized snapshot, a monotonic
 * revision, and a producer lease. A newer producer *replaces* the lease
 * (generation++), and the replaced producer id is tombstoned so a delayed
 * publish from it cannot take the session back. Within one lease revisions must
 * increase or the publish is refused (409), so a reordered packet cannot
 * overwrite newer domain state. Connection health (`connected`, `lastSeen`) is
 * derived from heartbeats and is never written into worker statuses.
 *
 * ── Singleton identity ─────────────────────────────────────────────────────
 * A lifetime OS-exclusive bind is the actual singleton guard, not the fs lock:
 * Linux abstract Unix socket (auto-freed on process death, no stale file),
 * Windows named pipe, and a filesystem socket elsewhere. The name hashes
 * runtimeDir + uid + protocol, so two runtime directories coexist and two
 * servers for one directory cannot both serve. A loser exits with
 * `SINGLETON_EXIT_CODE` before writing metadata or the producer token, and the
 * parent lifecycle adopts the winner's authenticated health instead.
 *
 * ── Bounds ─────────────────────────────────────────────────────────────────
 * Snapshot bodies (8 MiB), artifact bodies (2 MiB), active session count,
 * child/artifact counts, SSE client count, SSE buffered bytes, and
 * disconnected-record retention are all capped. A slow browser is disconnected
 * rather than buffered forever. Capacity is refused (429) instead of evicting a
 * live producer: eviction would make two healthy Pi sessions fight over the same
 * slots, so only lapsed records are reclaimed.
 */
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createNetServer, Socket } from "node:net";
import type { Server as NetServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";
import { openEventChannel, SSE_ROUTE_OPTIONS, type EventChannel } from "../../../core/http/sse.ts";

import { createGraphApp } from "./app.ts";
import { SUBAGENT_GRAPH_PROTOCOL } from "./protocol.ts";
import type {
  SubagentGraphArtifact,
  SubagentGraphSessionSummary,
  SubagentGraphSessionView,
  SubagentGraphSnapshot,
} from "./protocol.ts";
import {
  MAX_SNAPSHOT_BYTES,
  ValidationError,
  projectArtifacts,
  sanitizeSnapshot,
} from "./validation.ts";

export const SUBAGENT_GRAPH_HOST = "127.0.0.1";
export const DEFAULT_PREFERRED_PORT = 9177;
export const DEFAULT_IDLE_MS = 30_000;
export const DEFAULT_PRODUCER_TTL_MS = 30_000;
export const BROWSER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_BROWSER_SESSIONS = 64;
export const MAX_SSE_CLIENTS = 32;
export const MAX_SSE_BUFFER_BYTES = 1 * 1024 * 1024;
export const MAX_SESSIONS = 64;
/** How long a disconnected session stays visible with its last observed state. */
export const DEFAULT_RETENTION_MS = 5 * 60 * 1000;
export const MAX_TOMBSTONES = 2048;

export const METADATA_FILE = "server.json";
export const PRODUCER_TOKEN_FILE = "producer-token";
/** Exit code used when another server already owns this runtime directory. */
export const SINGLETON_EXIT_CODE = 3;

/** Another live server holds the singleton for this runtime directory. */
export class SingletonUnavailableError extends Error {
  constructor(message = "another subagent-graph server already owns this runtime directory") {
    super(message);
    this.name = "SingletonUnavailableError";
  }
}

interface SingletonHandle {
  release(): Promise<void>;
}

const COOKIE_NAME = "pi_subagent-graph";

export interface SubagentGraphServerOptions {
  /** Private per-user directory holding `server.json` and `producer-token`. */
  runtimeDir: string;
  /** Preferred fixed port; `0` means "ephemeral only". Defaults to 9177, falling back to ephemeral. */
  preferredPort?: number;
  /** Directory holding `index.html` + `dist/`. Defaults to `<repo>/web/plugins/subagent-graph/app`. */
  webRoot?: string;
  /** Shut down after this long with no producers and no browsers. `0` disables idle shutdown. */
  idleMs?: number;
  /** A producer lease expires (connection health only) after this long without contact. */
  producerTtlMs?: number;
  /** How long a lapsed session keeps its last observed state before being dropped. */
  retentionMs?: number;
  maxSnapshotBytes?: number;
  maxSessions?: number;
  maxSseClients?: number;
  maxSseBufferBytes?: number;
  /** OS-exclusive lifetime singleton. Always true in production; tests use unique dirs. */
  singleton?: boolean;
  /** SSE comment keep-alive interval; `0` disables pings. */
  ssePingMs?: number;
  sseDebounceMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface SubagentGraphRuntimeMetadata {
  protocol: typeof SUBAGENT_GRAPH_PROTOCOL;
  instanceId: string;
  pid: number;
  host: string;
  port: number;
  url: string;
  browserUrl: string;
  startedAt: number;
}

export interface SubagentGraphServerStats {
  ok: true;
  protocol: typeof SUBAGENT_GRAPH_PROTOCOL;
  instanceId: string;
  pid: number;
  port: number;
  url: string;
  sessions: number;
  producers: number;
  connectedProducers: number;
  sseClients: number;
  uptimeMs: number;
}

export interface SubagentGraphServerHandle {
  readonly instanceId: string;
  readonly port: number;
  readonly url: string;
  readonly browserUrl: string;
  readonly producerToken: string;
  readonly runtimeDir: string;
  readonly pid: number;
  /** Resolves once the listener and all SSE responses are closed. */
  readonly closed: Promise<void>;
  close(reason?: string): Promise<void>;
  stats(): SubagentGraphServerStats;
  /** Metadata as written to disk, useful for tests and lifecycle verification. */
  metadata(): SubagentGraphRuntimeMetadata;
}

interface SessionRecord {
  sessionId: string;
  producerId: string;
  generation: number;
  revision: number;
  snapshot: SubagentGraphSnapshot;
  lastSeen: number;
  connected: boolean;
  registeredAt: number;
}

interface ResolvedOptions extends Required<Omit<SubagentGraphServerOptions, "now" | "log">> {
  now: () => number;
  log: (line: string) => void;
}

/** Which credential a graph API route accepts. */
type ApiAuth = "any" | "browser" | "producer";

interface GraphApiRoute {
  path: string;
  method: "GET" | "POST";
  auth: ApiAuth;
  handle: (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function defaultWebRoot(): string {
  // web/plugins/subagent-graph/lib/server.ts -> ../app
  return fileURLToPath(new URL("../app/", import.meta.url));
}

/** Derive the OS-level singleton name from runtime directory + user + protocol. */
export function singletonLockKey(runtimeDir: string): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "nouid";
  return createHash("sha256")
    .update(`${resolve(runtimeDir)}\u0000${uid}\u0000${SUBAGENT_GRAPH_PROTOCOL}`)
    .digest("hex")
    .slice(0, 32);
}

async function listenOnSocket(path: string): Promise<NetServer> {
  return new Promise<NetServer>((resolveListen, reject) => {
    const net = createNetServer((socket: Socket) => socket.destroy());
    const onError = (error: Error) => {
      net.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      net.off("error", onError);
      resolveListen(net);
    };
    net.once("error", onError);
    net.once("listening", onListening);
    net.listen(path);
  });
}

function isAddrInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}

/**
 * Probe whether a filesystem Unix socket still has a live listener. Used only by
 * the non-Linux/non-Windows fallback, where socket files survive a crash.
 */
function socketIsLive(path: string): Promise<boolean> {
  return new Promise(resolveProbe => {
    const socket = new Socket();
    let settled = false;
    const done = (live: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(live);
    };
    socket.setTimeout(300);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
    socket.connect(path);
  });
}

/**
 * Acquire the lifetime OS-exclusive singleton for a runtime directory. The holder
 * keeps it open until shutdown, so process death frees it automatically (abstract
 * UDS / named pipe) instead of leaving a lock that needs stale detection.
 */
async function acquireSingleton(runtimeDir: string): Promise<SingletonHandle> {
  const key = singletonLockKey(runtimeDir);
  if (process.platform === "linux") {
    try {
      const net = await listenOnSocket(`\u0000pi-subagent-graph-${key}`);
      return {
        release: async () => {
          await new Promise<void>(resolveClose => net.close(() => resolveClose()));
        },
      };
    } catch (error) {
      if (isAddrInUse(error)) throw new SingletonUnavailableError();
      throw error;
    }
  }
  if (process.platform === "win32") {
    try {
      const net = await listenOnSocket(`\\\\.\\pipe\\pi-subagent-graph-${key}`);
      return {
        release: async () => {
          await new Promise<void>(resolveClose => net.close(() => resolveClose()));
        },
      };
    } catch (error) {
      if (isAddrInUse(error)) throw new SingletonUnavailableError();
      throw error;
    }
  }
  // POSIX filesystem socket fallback. A leftover socket file needs a liveness
  // probe before unlink, and the unlink/rebind window is not atomic; that is
  // why Linux/Windows use the handle-released variants above.
  const path = join(runtimeDir, `singleton-${key.slice(0, 16)}.sock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const net = await listenOnSocket(path);
      return {
        release: async () => {
          await new Promise<void>(resolveClose => net.close(() => resolveClose()));
          await unlink(path).catch(() => {});
        },
      };
    } catch (error) {
      if (!isAddrInUse(error)) throw error;
      if (await socketIsLive(path)) throw new SingletonUnavailableError();
      await unlink(path).catch(() => {});
    }
  }
  throw new SingletonUnavailableError();
}

function resolveOptions(options: SubagentGraphServerOptions): ResolvedOptions {
  if (typeof options.runtimeDir !== "string" || options.runtimeDir.length === 0) {
    throw new Error("runtimeDir is required");
  }
  return {
    runtimeDir: options.runtimeDir,
    preferredPort: options.preferredPort ?? DEFAULT_PREFERRED_PORT,
    webRoot: options.webRoot ?? defaultWebRoot(),
    idleMs: options.idleMs ?? DEFAULT_IDLE_MS,
    producerTtlMs: options.producerTtlMs ?? DEFAULT_PRODUCER_TTL_MS,
    retentionMs: options.retentionMs ?? DEFAULT_RETENTION_MS,
    maxSnapshotBytes: options.maxSnapshotBytes ?? MAX_SNAPSHOT_BYTES,
    maxSessions: options.maxSessions ?? MAX_SESSIONS,
    maxSseClients: options.maxSseClients ?? MAX_SSE_CLIENTS,
    maxSseBufferBytes: options.maxSseBufferBytes ?? MAX_SSE_BUFFER_BYTES,
    ssePingMs: options.ssePingMs ?? 15_000,
    sseDebounceMs: options.sseDebounceMs ?? 25,
    singleton: options.singleton ?? true,
    now: options.now ?? Date.now,
    log: options.log ?? (() => {}),
  };
}

// ── Runtime directory helpers (shared with lifecycle.ts) ────────────────────

/**
 * Create the private runtime directory if needed and verify it is a real
 * directory we own. Mode 0700, no symlink indirection.
 */
export async function ensurePrivateRuntimeDir(runtimeDir: string): Promise<string> {
  const dir = resolve(runtimeDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`subagent-graph runtime path is not a directory: ${dir}`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`subagent-graph runtime directory is owned by another user: ${dir}`);
  }
  if (process.platform !== "win32") await chmod(dir, 0o700).catch(() => {});
  return dir;
}

function metadataPath(runtimeDir: string): string {
  return join(runtimeDir, METADATA_FILE);
}

function producerTokenPath(runtimeDir: string): string {
  return join(runtimeDir, PRODUCER_TOKEN_FILE);
}

/** Write a file atomically with owner-only permissions. */
async function writePrivateFile(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, path);
  if (process.platform !== "win32") await chmod(path, 0o600).catch(() => {});
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Read the producer token, creating it on first use. It survives server restarts. */
export async function readOrCreateProducerToken(runtimeDir: string): Promise<string> {
  try {
    const raw = (await readFile(producerTokenPath(runtimeDir), "utf8")).trim();
    if (validToken(raw)) return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("hex");
  await writePrivateFile(producerTokenPath(runtimeDir), token);
  return token;
}

export async function readProducerToken(runtimeDir: string): Promise<string | null> {
  try {
    const raw = (await readFile(producerTokenPath(runtimeDir), "utf8")).trim();
    return validToken(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Read and shape-check the on-disk metadata. Returns null for corrupt/foreign data. */
export async function readRuntimeMetadata(runtimeDir: string): Promise<SubagentGraphRuntimeMetadata | null> {
  try {
    const raw = await readFile(metadataPath(runtimeDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const data = parsed as Record<string, unknown>;
    if (data.protocol !== SUBAGENT_GRAPH_PROTOCOL) return null;
    if (typeof data.instanceId !== "string" || data.instanceId.length < 8) return null;
    if (typeof data.port !== "number" || !Number.isInteger(data.port) || data.port <= 0 || data.port > 65535) return null;
    if (typeof data.pid !== "number" || !Number.isInteger(data.pid) || data.pid <= 0) return null;
    return {
      protocol: SUBAGENT_GRAPH_PROTOCOL,
      instanceId: data.instanceId,
      pid: data.pid,
      host: SUBAGENT_GRAPH_HOST,
      port: data.port,
      url: `http://${SUBAGENT_GRAPH_HOST}:${data.port}/`,
      browserUrl: typeof data.browserUrl === "string" ? data.browserUrl : `http://${SUBAGENT_GRAPH_HOST}:${data.port}/`,
      startedAt: typeof data.startedAt === "number" ? data.startedAt : 0,
    };
  } catch {
    return null;
  }
}

/** Remove metadata only when it still belongs to `instanceId`. */
export async function removeRuntimeMetadata(runtimeDir: string, instanceId: string): Promise<void> {
  const current = await readRuntimeMetadata(runtimeDir);
  if (current !== null && current.instanceId !== instanceId) return;
  await unlink(metadataPath(runtimeDir)).catch(() => {});
}

// ── Small HTTP helpers ──────────────────────────────────────────────────────

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

function securityHeaders(res: ServerResponse): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("cross-origin-opener-policy", "same-origin");
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  securityHeaders(res);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  if (extraHeaders) for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function bearer(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+([0-9a-f]{64})$/i.exec(header.trim());
  return match === null ? null : match[1]!;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function hostHeaderAllowed(host: string | undefined, port: number): boolean {
  if (typeof host !== "string" || host.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return false;
  }
  // Exact port match prevents an attacker page on another loopback port from
  // reusing this server's auth with a rebinding-friendly host.
  const effectivePort = parsed.port === "" ? 80 : Number(parsed.port);
  return isLoopbackHostname(parsed.hostname) && effectivePort === port;
}

function originAllowed(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    const effectivePort = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
    if (parsed.protocol !== "http:" || !isLoopbackHostname(parsed.hostname) || effectivePort !== port) return false;
  }
  const fetchSite = req.headers["sec-fetch-site"];
  if (typeof fetchSite === "string" && fetchSite === "cross-site") return false;
  return true;
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = req.headers["content-length"];
  if (typeof declared === "string") {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0) throw new HttpError(400, "invalid content-length");
    if (length > max) throw new HttpError(413, "payload too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > max) tooLarge = true;
    else chunks.push(buffer);
    // Stop buffering but keep draining so the 413 can still be delivered.
    if (size > max * 2) break;
  }
  if (tooLarge) throw new HttpError(413, "payload too large");
  return Buffer.concat(chunks);
}

function envelopeDict(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

// ── Server ──────────────────────────────────────────────────────────────────

class SubagentGraphRuntime {
  readonly #options: ResolvedOptions;
  #app: FastifyInstance | null = null;
  readonly #instanceId = randomBytes(16).toString("hex");
  readonly #bootstrapToken = randomBytes(32).toString("hex");
  readonly #startedAt = Date.now();
  #producerToken = "";
  #port = 0;
  #singleton: SingletonHandle | null = null;

  readonly #sessions = new Map<string, SessionRecord>();
  readonly #tombstones = new Map<string, number>();
  readonly #browserSessions = new Map<string, number>();
  readonly #sseClients = new Set<EventChannel>();
  #lastActivityAt = Date.now();
  #notifyTimer: NodeJS.Timeout | null = null;
  #sweepTimer: NodeJS.Timeout | null = null;
  #eventPressureTimer: NodeJS.Timeout | null = null;
  #closing: Promise<void> | null = null;
  #closedResolve: (() => void) | null = null;
  #closed = new Promise<void>(resolve => {
    this.#closedResolve = resolve;
  });
  #closeReason = "";

  constructor(options: ResolvedOptions) {
    this.#options = options;
  }

  get closed(): Promise<void> {
    return this.#closed;
  }

  get instanceId(): string {
    return this.#instanceId;
  }

  async start(): Promise<SubagentGraphServerHandle> {
    await ensurePrivateRuntimeDir(this.#options.runtimeDir);
    // The OS-exclusive lifetime bind comes BEFORE any state is written: a losing
    // duplicate must not overwrite the winner's token or metadata.
    if (this.#options.singleton) this.#singleton = await acquireSingleton(this.#options.runtimeDir);
    let metadata: SubagentGraphRuntimeMetadata;
    try {
      this.#producerToken = await readOrCreateProducerToken(this.#options.runtimeDir);
      await this.#listen();
      metadata = {
        protocol: SUBAGENT_GRAPH_PROTOCOL,
        instanceId: this.#instanceId,
        pid: process.pid,
        host: SUBAGENT_GRAPH_HOST,
        port: this.#port,
        url: this.#url(),
        browserUrl: `${this.#url()}bootstrap?token=${this.#bootstrapToken}`,
        startedAt: this.#startedAt,
      };
      await writePrivateFile(metadataPath(this.#options.runtimeDir), JSON.stringify(metadata));
      this.#startTimers();
      this.#log(`subagent-graph ready at ${this.#url()} (pid ${process.pid})`);
    } catch (error) {
      await this.#singleton?.release().catch(() => {});
      this.#singleton = null;
      throw error;
    }

    return {
      instanceId: this.#instanceId,
      port: this.#port,
      url: this.#url(),
      browserUrl: metadata.browserUrl,
      producerToken: this.#producerToken,
      runtimeDir: this.#options.runtimeDir,
      pid: process.pid,
      closed: this.#closed,
      close: (reason?: string) => this.close(reason ?? "manual"),
      stats: () => this.stats(),
      metadata: () => metadata,
    };
  }

  #url(): string {
    return `http://${SUBAGENT_GRAPH_HOST}:${this.#port}/`;
  }

  #log(line: string): void {
    this.#options.log(`${new Date().toISOString()} ${line}`);
  }

  async #listen(): Promise<void> {
    const app = await createGraphApp({
      staticRoot: this.#options.webRoot,
      heartbeatInterval: this.#options.ssePingMs,
      guard: (req, res) => this.#guard(req, res),
    });
    this.#app = app;
    this.#registerApiRoutes(app);
    this.#configureServer(app);
    const preferred = this.#options.preferredPort;
    if (preferred > 0) {
      try {
        await app.listen({ port: preferred, host: SUBAGENT_GRAPH_HOST });
        this.#port = this.#boundPort(app, preferred);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
        this.#log(`preferred port ${preferred} unavailable (${code}); using an ephemeral port`);
      }
    }
    await app.listen({ port: 0, host: SUBAGENT_GRAPH_HOST });
    this.#port = this.#boundPort(app, 0);
  }

  /** Timeouts and the raw-server error policy the graph host has always used. */
  #configureServer(app: FastifyInstance): void {
    const server = app.server;
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.on("clientError", (_error, socket) => {
      if (!socket.destroyed) socket.destroy();
    });
    server.on("error", error => this.#log(`server error: ${String(error)}`));
  }

  #boundPort(app: FastifyInstance, fallback: number): number {
    const address = app.server.address();
    return typeof address === "object" && address !== null ? address.port : fallback;
  }

  #startTimers(): void {
    const { idleMs, producerTtlMs, now } = this.#options;
    const sweepMs = Math.max(
      50,
      Math.min(
        1000,
        Math.floor((producerTtlMs > 0 ? producerTtlMs / 4 : 1000) as number),
        idleMs > 0 ? Math.max(50, Math.floor(idleMs / 4)) : 1000,
      ),
    );
    this.#sweepTimer = setInterval(() => this.#sweep(now()), sweepMs);
    this.#sweepTimer.unref();
    this.#lastActivityAt = now();
    if (this.#options.ssePingMs > 0) {
      // The plugin sends keepalive comments; this timer only enforces the
      // graph's application-owned client byte cap between notifications.
      this.#eventPressureTimer = setInterval(() => this.#checkEventPressure(), this.#options.ssePingMs);
      this.#eventPressureTimer.unref();
    }
  }

  // ── Request dispatch ─────────────────────────────────────────────────────

  /** Loopback Host/Origin gate, run in `onRequest` for every request. */
  #guard(req: IncomingMessage, res: ServerResponse): boolean {
    if (!hostHeaderAllowed(req.headers.host, this.#port)) {
      sendJson(res, 403, { error: "invalid host" });
      return false;
    }
    if (!originAllowed(req, this.#port)) {
      sendJson(res, 403, { error: "invalid origin" });
      return false;
    }
    // Every request that passed the gate counts as activity, whichever route
    // (native or delegated) ends up serving it — this is what keeps a
    // heartbeating producer from idling the server out.
    this.#lastActivityAt = this.#options.now();
    return true;
  }

  #fail(res: ServerResponse, error: unknown): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message });
      return;
    }
    if (error instanceof ValidationError) {
      sendJson(res, error.status, { error: error.message });
      return;
    }
    this.#log(`request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    sendJson(res, 500, { error: "internal error" });
  }

  // ── Browser bootstrap ────────────────────────────────────────────────────

  #bootstrap(url: URL, res: ServerResponse): void {
    const token = url.searchParams.get("token") ?? "";
    if (!safeEqual(token, this.#bootstrapToken)) {
      sendJson(res, 403, { error: "invalid bootstrap token" });
      return;
    }
    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = this.#options.now() + BROWSER_SESSION_TTL_MS;
    this.#browserSessions.set(sessionToken, expiresAt);
    while (this.#browserSessions.size > MAX_BROWSER_SESSIONS) {
      const oldest = this.#browserSessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#browserSessions.delete(oldest);
    }
    securityHeaders(res);
    res.setHeader("cache-control", "no-store");
    res.setHeader(
      "set-cookie",
      `${COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(BROWSER_SESSION_TTL_MS / 1000)}`,
    );
    res.statusCode = 302;
    res.setHeader("location", "/");
    res.end();
  }

  // ── Authentication ───────────────────────────────────────────────────────

  #isProducer(req: IncomingMessage): boolean {
    const token = bearer(req.headers.authorization);
    return token !== null && safeEqual(token, this.#producerToken);
  }

  #browserToken(req: IncomingMessage): string | null {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return null;
    const expiresAt = this.#browserSessions.get(token);
    if (expiresAt === undefined) return null;
    if (expiresAt <= this.#options.now()) {
      this.#browserSessions.delete(token);
      return null;
    }
    return token;
  }

  /** Whether a request satisfies a route's API authentication requirement. */
  #apiAuthorized(requirement: ApiAuth, req: IncomingMessage): boolean {
    if (requirement === "producer") return this.#isProducer(req);
    if (requirement === "browser") return this.#browserToken(req) !== null;
    return this.#isProducer(req) || this.#browserToken(req) !== null;
  }

  // ── API ──────────────────────────────────────────────────────────────────

  /**
   * Register the graph's API as native Fastify routes. Authentication runs in
   * each route's `onRequest` hook, so it is decided before any body is read —
   * the order the old dispatcher used. The handlers keep the runtime's raw
   * response helpers and body reader (`#readEnvelope`), which the app's no-op
   * content type parser deliberately leaves on the wire.
   */
  #registerApiRoutes(app: FastifyInstance): void {
    app.all("/bootstrap", async (request, reply) => {
      reply.hijack();
      try {
        this.#bootstrap(new URL(request.url, "http://localhost"), reply.raw);
      } catch (error) {
        this.#fail(reply.raw, error);
      }
    });
    this.#registerEventsRoute(app);
    const routes: readonly GraphApiRoute[] = [
      { path: "/api/health", method: "GET", auth: "any", handle: (_req, res) => sendJson(res, 200, this.stats()) },
      {
        path: "/api/sessions",
        method: "GET",
        auth: "browser",
        handle: (_req, res) => sendJson(res, 200, { sessions: this.#sessionSummaries() }),
      },
      { path: "/api/session", method: "GET", auth: "browser", handle: (_req, res, url) => this.#sendSession(res, url) },
      { path: "/api/artifact", method: "GET", auth: "browser", handle: (_req, res, url) => this.#sendArtifact(res, url) },
      { path: "/api/producer/publish", method: "POST", auth: "producer", handle: (req, res) => this.#publish(req, res) },
      {
        path: "/api/producer/heartbeat",
        method: "POST",
        auth: "producer",
        handle: (req, res) => this.#heartbeat(req, res),
      },
      {
        path: "/api/producer/unregister",
        method: "POST",
        auth: "producer",
        handle: (req, res) => this.#unregister(req, res),
      },
    ];
    for (const route of routes) {
      app.all(
        route.path,
        {
          onRequest: async (request, reply) => {
            if (this.#apiAuthorized(route.auth, request.raw)) return;
            sendJson(reply.raw, 401, { error: "unauthorized" });
            reply.hijack();
          },
        },
        async (request, reply) => {
          if (request.method !== route.method) {
            reply.hijack();
            sendJson(reply.raw, 405, { error: `method not allowed; use ${route.method}` });
            return;
          }
          const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
          reply.hijack();
          try {
            await route.handle(request.raw, reply.raw, url);
          } catch (error) {
            this.#fail(reply.raw, error);
          }
        },
      );
    }
  }

  #sessionSummaries(): SubagentGraphSessionSummary[] {
    const now = this.#options.now();
    return [...this.#sessions.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen || a.sessionId.localeCompare(b.sessionId))
      .map(record => {
        const running = record.snapshot.delegation.children.filter(child => child.status === "running").length;
        return {
          ...record.snapshot.session,
          connected: this.#connected(record, now),
          lastSeen: record.lastSeen,
          revision: record.revision,
          workers: { running, total: record.snapshot.delegation.children.length },
        };
      });
  }

  #connected(record: SessionRecord, now: number): boolean {
    return record.connected && now - record.lastSeen <= this.#options.producerTtlMs;
  }

  #sessionView(record: SessionRecord): SubagentGraphSessionView {
    const now = this.#options.now();
    return {
      session: record.snapshot.session,
      delegation: record.snapshot.delegation,
      artifacts: projectArtifacts(record.snapshot),
      connected: this.#connected(record, now),
      lastSeen: record.lastSeen,
      revision: record.revision,
    };
  }

  #sendSession(res: ServerResponse, url: URL): void {
    const sessionId = url.searchParams.get("id") ?? "";
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      sendJson(res, 404, { error: "unknown session" });
      return;
    }
    sendJson(res, 200, { session: this.#sessionView(record) });
  }

  #sendArtifact(res: ServerResponse, url: URL): void {
    const sessionId = url.searchParams.get("session") ?? "";
    const artifactId = url.searchParams.get("id") ?? "";
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      sendJson(res, 404, { error: "unknown session" });
      return;
    }
    const artifact = record.snapshot.artifacts.find(item => item.id === artifactId);
    if (artifact === undefined) {
      sendJson(res, 404, { error: "unknown artifact" });
      return;
    }
    const versionParam = url.searchParams.get("version");
    if (versionParam !== null) {
      const version = Number(versionParam);
      if (!Number.isInteger(version) || version < 0) {
        sendJson(res, 400, { error: "invalid version" });
        return;
      }
      if (version !== artifact.version) {
        // The producer only publishes current catalog entries; a request for a
        // superseded body gets an explicit conflict, not stale content.
        sendJson(res, 409, { error: "artifact version changed", version: artifact.version });
        return;
      }
    }
    const body: SubagentGraphArtifact = artifact;
    sendJson(res, 200, { artifact: body });
  }

  // ── SSE ──────────────────────────────────────────────────────────────────

  #registerEventsRoute(app: FastifyInstance): void {
    const method = "GET";
    app.all("/api/events", {
      sse: { ...SSE_ROUTE_OPTIONS, heartbeat: true },
      onRequest: async (request, reply) => {
        if (this.#apiAuthorized("browser", request.raw)) return;
        return reply.code(401).header("cache-control", "no-store").send({ error: "unauthorized" });
      },
    }, async (request, reply) => {
      if (request.method !== method) {
        return reply.code(405).header("cache-control", "no-store").send({ error: `method not allowed; use ${method}` });
      }
      this.#openEvents(reply);
    });
  }

  #openEvents(reply: FastifyReply): void {
    if (this.#sseClients.size >= this.#options.maxSseClients) {
      void reply.code(429).header("cache-control", "no-store").send({ error: "too many event streams" });
      return;
    }
    reply.header("cache-control", "no-store");
    const channel = openEventChannel(reply, {
      dropAboveBytes: this.#options.maxSseBufferBytes,
      closeAboveBytes: this.#options.maxSseBufferBytes,
    });
    this.#sseClients.add(channel);
    channel.onClose(() => this.#sseClients.delete(channel));
    channel.send({ type: "changed" }, { retry: 2000 });
  }

  #notify(): void {
    if (this.#closing !== null || this.#sseClients.size === 0) return;
    if (this.#notifyTimer !== null) return;
    this.#notifyTimer = setTimeout(() => {
      this.#notifyTimer = null;
      this.#broadcast();
    }, this.#options.sseDebounceMs);
    this.#notifyTimer.unref();
  }

  #broadcast(): void {
    for (const channel of this.#sseClients) channel.send({ type: "changed" });
  }

  #checkEventPressure(): void {
    for (const channel of this.#sseClients) channel.checkPressure();
  }

  // ── Producer transport ───────────────────────────────────────────────────

  async #readEnvelope(req: IncomingMessage): Promise<Record<string, unknown>> {
    const type = req.headers["content-type"];
    if (typeof type !== "string" || !type.toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "expected application/json");
    }
    const body = await readBody(req, this.#options.maxSnapshotBytes);
    if (body.length === 0) throw new ValidationError("empty body");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      throw new ValidationError("invalid JSON");
    }
    return envelopeDict(parsed);
  }

  #leaseIds(envelope: Record<string, unknown>): { sessionId: string; producerId: string; generation: number } {
    const sessionId = envelope.sessionId;
    const producerId = envelope.producerId;
    const generation = envelope.generation ?? 0;
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(sessionId)) {
      throw new ValidationError("invalid sessionId");
    }
    if (typeof producerId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(producerId)) {
      throw new ValidationError("invalid producerId");
    }
    if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 0 || generation > 1e9) {
      throw new ValidationError("invalid generation");
    }
    return { sessionId, producerId, generation };
  }

  async #publish(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const envelope = await this.#readEnvelope(req);
    const { sessionId, producerId, generation } = this.#leaseIds(envelope);
    const revision = envelope.revision;
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1 || revision > 1e9) {
      throw new ValidationError("invalid revision");
    }
    const snapshot = sanitizeSnapshot(envelope.snapshot);
    if (snapshot.session.id !== sessionId) {
      throw new ValidationError("sessionId does not match snapshot.session.id");
    }
    const now = this.#options.now();

    // Checked before admitting a record too: a replaced producer whose session
    // has since expired or been replaced must not create a fresh lease from an
    // in-flight packet that predates the takeover.
    if (this.#tombstones.has(producerId)) {
      sendJson(res, 410, { error: "superseded" });
      return;
    }

    let record = this.#sessions.get(sessionId);
    if (record === undefined) {
      record = {
        sessionId,
        producerId,
        generation: 1,
        revision,
        snapshot,
        lastSeen: now,
        connected: true,
        registeredAt: now,
      };
      this.#admit();
      this.#sessions.set(sessionId, record);
      this.#notify();
      sendJson(res, 200, { instanceId: this.#instanceId, generation: record.generation, revision, accepted: true });
      return;
    }

    if (record.producerId !== producerId) {
      this.#tombstone(record.producerId, now);
      record.producerId = producerId;
      record.generation += 1;
      record.revision = revision;
      record.snapshot = snapshot;
      record.lastSeen = now;
      record.connected = true;
      record.registeredAt = now;
      this.#notify();
      sendJson(res, 200, { instanceId: this.#instanceId, generation: record.generation, revision, accepted: true });
      return;
    }

    if (generation > 0 && generation !== record.generation) {
      sendJson(res, 410, { error: "superseded", generation: record.generation });
      return;
    }
    if (revision <= record.revision) {
      sendJson(res, 409, { error: "stale revision", revision: record.revision, generation: record.generation });
      return;
    }
    record.revision = revision;
    record.snapshot = snapshot;
    record.lastSeen = now;
    record.connected = true;
    this.#notify();
    sendJson(res, 200, { instanceId: this.#instanceId, generation: record.generation, revision, accepted: true });
  }

  async #heartbeat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const envelope = await this.#readEnvelope(req);
    const { sessionId, producerId, generation } = this.#leaseIds(envelope);
    if (this.#tombstones.has(producerId)) {
      sendJson(res, 410, { error: "superseded" });
      return;
    }
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      // After a server restart the producer must re-register with a full
      // snapshot; a heartbeat alone cannot reconstruct domain state.
      sendJson(res, 404, { error: "unregistered", instanceId: this.#instanceId });
      return;
    }
    if (record.producerId !== producerId || (generation > 0 && generation !== record.generation)) {
      sendJson(res, 410, { error: "superseded" });
      return;
    }
    const now = this.#options.now();
    const wasConnected = this.#connected(record, now);
    record.lastSeen = now;
    record.connected = true;
    if (!wasConnected) this.#notify();
    sendJson(res, 200, { ok: true, instanceId: this.#instanceId, generation: record.generation, revision: record.revision });
  }

  async #unregister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const envelope = await this.#readEnvelope(req);
    const { sessionId, producerId } = this.#leaseIds(envelope);
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      sendJson(res, 200, { ok: true, removed: false });
      return;
    }
    if (record.producerId !== producerId) {
      // Closing a producer that was already replaced is a no-op, never a
      // removal of the current owner's state.
      sendJson(res, 200, { ok: true, removed: false, reason: "not owner" });
      return;
    }
    // A graceful close is a retraction: the session is gone, so the card goes
    // with it. Keeping a "disconnected" ghost for the retention window made a
    // closed session look like work still in flight, which is the opposite of
    // what the sidebar is for. Producers that vanish without unregistering (a
    // crash, SIGKILL) are still retained by the sweep, marked disconnected, so a
    // restart can resume them.
    this.#sessions.delete(sessionId);
    this.#notify();
    sendJson(res, 200, { ok: true, removed: true });
  }

  #admit(): void {
    if (this.#sessions.size < this.#options.maxSessions) return;
    // Bounded state, but never at the cost of a live producer: evicting a
    // connected session would just make it re-register (and evict someone else),
    // so a full server refuses the newcomer and the producer retries. Only a
    // lapsed record is reclaimed, which cannot thrash.
    const now = this.#options.now();
    let victim: SessionRecord | null = null;
    for (const candidate of this.#sessions.values()) {
      if (this.#connected(candidate, now)) continue;
      if (victim === null || candidate.lastSeen < victim.lastSeen) victim = candidate;
    }
    if (victim === null) throw new HttpError(429, "too many active sessions");
    this.#sessions.delete(victim.sessionId);
  }

  #tombstone(producerId: string, now: number): void {
    this.#tombstones.set(producerId, now);
    while (this.#tombstones.size > MAX_TOMBSTONES) {
      const oldest = this.#tombstones.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#tombstones.delete(oldest);
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  #sweep(now: number): void {
    let changed = false;
    for (const [sessionId, record] of this.#sessions) {
      const connected = this.#connected(record, now);
      if (record.connected && !connected) {
        // Connection health changes; domain state (worker statuses) is untouched.
        record.connected = false;
        changed = true;
      }
      if (!connected && now - record.lastSeen > this.#options.retentionMs) {
        this.#sessions.delete(sessionId);
        changed = true;
      }
    }
    for (const [token, expiresAt] of this.#browserSessions) {
      if (expiresAt <= now) this.#browserSessions.delete(token);
    }
    if (changed) this.#notify();

    if (this.#closing !== null) return;
    const idleMs = this.#options.idleMs;
    if (idleMs <= 0) return;
    const hasConnectedProducer = [...this.#sessions.values()].some(record => this.#connected(record, now));
    if (hasConnectedProducer || this.#sseClients.size > 0) {
      this.#lastActivityAt = Math.max(this.#lastActivityAt, now);
      return;
    }
    if (now - this.#lastActivityAt >= idleMs) {
      void this.close("idle");
    }
  }

  close(reason = "manual"): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closeReason = reason;
    this.#closing = (async () => {
      if (this.#notifyTimer !== null) clearTimeout(this.#notifyTimer);
      if (this.#sweepTimer !== null) clearInterval(this.#sweepTimer);
      if (this.#eventPressureTimer !== null) clearInterval(this.#eventPressureTimer);
      this.#notifyTimer = null;
      this.#sweepTimer = null;
      this.#eventPressureTimer = null;
      for (const channel of this.#sseClients) channel.close();
      this.#sseClients.clear();
      const closedServer = this.#app?.close() ?? Promise.resolve();
      await closedServer;
      await removeRuntimeMetadata(this.#options.runtimeDir, this.#instanceId);
      await this.#singleton?.release().catch(() => {});
      this.#singleton = null;
      this.#log(`subagent-graph closed (${reason})`);
      this.#closedResolve?.();
    })();
    return this.#closing;
  }

  stats(): SubagentGraphServerStats {
    const now = this.#options.now();
    let connected = 0;
    for (const record of this.#sessions.values()) if (this.#connected(record, now)) connected += 1;
    return {
      ok: true,
      protocol: SUBAGENT_GRAPH_PROTOCOL,
      instanceId: this.#instanceId,
      pid: process.pid,
      port: this.#port,
      url: this.#url(),
      sessions: this.#sessions.size,
      producers: this.#sessions.size,
      connectedProducers: connected,
      sseClients: this.#sseClients.size,
      uptimeMs: now - this.#startedAt,
    };
  }

  get closeReason(): string {
    return this.#closeReason;
  }
}

/**
 * Start the shared subagent-graph server. Binds loopback only, writes private
 * runtime metadata atomically, and returns a handle. The caller owns shutdown;
 * the process-level entry point is `server-main.ts`.
 */
export async function startSubagentGraphServer(options: SubagentGraphServerOptions): Promise<SubagentGraphServerHandle> {
  const runtime = new SubagentGraphRuntime(resolveOptions(options));
  return runtime.start();
}
