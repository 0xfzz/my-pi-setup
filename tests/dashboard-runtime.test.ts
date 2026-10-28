/**
 * In-process tests for the shared dashboard runtime.
 *
 * The server is started directly (no spawn) so each behaviour can be asserted
 * deterministically: auth boundaries, projection, revision/takeover semantics,
 * SSE, health-vs-domain separation, idle shutdown, and the singleton/lock races.
 * Multi-process behaviour lives in dashboard-process.test.ts.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { ClientRequest, IncomingHttpHeaders } from "node:http";
import { mkdtemp, mkdir, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DashboardSnapshot } from "../lib/dashboard/protocol.ts";
import {
  ensureDashboard,
  stopDashboard,
  checkDashboardHealth,
  readDashboardAddress,
  defaultRuntimeDir,
  LOCK_FILE,
} from "../lib/dashboard/lifecycle.ts";
import type { DashboardAddress } from "../lib/dashboard/lifecycle.ts";
import { DashboardProducer } from "../lib/dashboard/producer.ts";
import {
  startDashboardServer,
  readRuntimeMetadata,
  SingletonUnavailableError,
  METADATA_FILE,
} from "../lib/dashboard/server.ts";
import type { DashboardServerHandle, DashboardServerOptions } from "../lib/dashboard/server.ts";
import { MAX_ARTIFACT_BYTES, sanitizeSnapshot, ValidationError } from "../lib/dashboard/validation.ts";
import { parseServerArgs } from "../lib/dashboard/server-main.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

type DashboardHandleOptions = DashboardServerOptions;

const tempDirs: string[] = [];
const spawnedAddresses: DashboardAddress[] = [];

async function tempDir(prefix = "pi-dash-rt-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

async function waitFor<T>(check: () => Promise<T | null | undefined | false>, label: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value as T;
    } catch (error) {
      last = error;
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}${last === undefined ? "" : `: ${String(last)}`}`);
}

let sessionCounter = 0;
function makeSnapshot(sessionId = `session-${++sessionCounter}`, mutate: (snapshot: DashboardSnapshot) => void = () => {}): DashboardSnapshot {
  const snapshot: DashboardSnapshot = {
    session: { id: sessionId, name: `Session ${sessionId}`, project: "project-a", mode: "orchestrator" },
    orchestrator: {
      children: [
        {
          id: "child-1",
          name: "worker-one",
          scope: "net-retry",
          status: "running",
          purpose: "implementation",
          laneFiles: ["src/net/retry.ts"],
          lastMilestoneFiles: [],
        },
      ],
      handoffs: [],
      reviews: [],
      escalations: [],
      specReviews: [],
      paused: false,
    },
    artifacts: [
      {
        id: "artifact-1",
        title: "Spec",
        type: "markdown",
        content: "# hello",
        version: 1,
        createdBy: "main",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        tags: ["spec"],
      },
    ],
  };
  mutate(snapshot);
  return snapshot;
}

async function withServer(
  overrides: Partial<DashboardServerOptions>,
  run: (context: { handle: DashboardServerHandle; runtimeDir: string }) => Promise<void>,
): Promise<void> {
  const runtimeDir = overrides.runtimeDir ?? (await tempDir());
  const handle = await startDashboardServer({
    runtimeDir,
    preferredPort: 0,
    idleMs: 0,
    ...overrides,
  } as DashboardHandleOptions);
  try {
    await run({ handle, runtimeDir });
  } finally {
    await handle.close();
  }
}

async function bootstrapCookie(handle: { browserUrl: string }): Promise<string> {
  const response = await fetch(handle.browserUrl, { redirect: "manual" });
  assert.equal(response.status, 302);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  const raw = cookies[0]!;
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Strict/);
  assert.match(raw, /Path=\//);
  return raw.split(";")[0]!;
}

function apiUrl(handle: { url: string }, path: string): URL {
  return new URL(path, handle.url);
}

async function getJson(
  handle: { url: string },
  path: string,
  cookie?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  const response = await fetch(apiUrl(handle, path), { headers });
  return { status: response.status, body: await response.json().catch(() => null) };
}

interface PublishOptions {
  producerId?: string;
  generation?: number;
  revision?: number;
  token?: string;
  contentType?: string | null;
  rawBody?: string;
}

const PRODUCER_A = "producer-aaaa1111";
const PRODUCER_B = "producer-bbbb2222";

async function publish(
  handle: DashboardServerHandle,
  snapshot: DashboardSnapshot,
  options: PublishOptions = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${options.token ?? handle.producerToken}` };
  if (options.contentType !== null) headers["content-type"] = options.contentType ?? "application/json";
  const response = await fetch(apiUrl(handle, "api/producer/publish"), {
    method: "POST",
    headers,
    body:
      options.rawBody ??
      JSON.stringify({
        sessionId: snapshot.session.id,
        producerId: options.producerId ?? PRODUCER_A,
        generation: options.generation ?? 0,
        revision: options.revision ?? 1,
        snapshot,
      }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function heartbeat(
  handle: DashboardServerHandle,
  sessionId: string,
  options: { producerId?: string; generation?: number } = {},
): Promise<number> {
  const response = await fetch(apiUrl(handle, "api/producer/heartbeat"), {
    method: "POST",
    headers: { authorization: `Bearer ${handle.producerToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      sessionId,
      producerId: options.producerId ?? PRODUCER_A,
      generation: options.generation ?? 0,
    }),
  });
  await response.arrayBuffer();
  return response.status;
}

async function unregister(
  handle: DashboardServerHandle,
  sessionId: string,
  producerId = PRODUCER_A,
): Promise<{ status: number; body: any }> {
  const response = await fetch(apiUrl(handle, "api/producer/unregister"), {
    method: "POST",
    headers: { authorization: `Bearer ${handle.producerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId, producerId, generation: 0 }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function rawRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...options.headers };
  return new Promise((resolveResponse, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers, setHost: false },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(Buffer.from(chunk)));
        res.on("end", () =>
          resolveResponse({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

interface EventStream {
  status: number;
  next(timeoutMs?: number): Promise<string>;
  close(): void;
}

function openEventStream(port: number, cookie?: string): Promise<EventStream> {
  return new Promise((resolveStream, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
    if (cookie) headers.cookie = cookie;
    let req: ClientRequest;
    req = httpRequest({ host: "127.0.0.1", port, path: "/api/events", headers, setHost: false }, res => {
      const status = res.statusCode ?? 0;
      if (status !== 200) {
        res.resume();
        res.on("end", () =>
          resolveStream({ status, next: () => Promise.reject(new Error("closed")), close: () => req.destroy() }),
        );
        return;
      }
      let buffer = "";
      const blocks: string[] = [];
      const waiters: Array<{ resolve: (block: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
      const deliver = (block: string) => {
        const waiter = waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(block);
        } else {
          blocks.push(block);
        }
      };
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf("\n\n");
        while (index >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          deliver(block);
          index = buffer.indexOf("\n\n");
        }
      });
      res.on("close", () => {
        for (const waiter of waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("stream closed"));
        }
      });
      resolveStream({
        status,
        next(timeoutMs = 3_000) {
          const block = blocks.shift();
          if (block !== undefined) return Promise.resolve(block);
          return new Promise((resolveBlock, rejectBlock) => {
            const timer = setTimeout(() => {
              const index = waiters.findIndex(waiter => waiter.timer === timer);
              if (index >= 0) waiters.splice(index, 1);
              rejectBlock(new Error("timed out waiting for SSE block"));
            }, timeoutMs);
            waiters.push({ resolve: resolveBlock, reject: rejectBlock, timer });
          });
        },
        close() {
          req.destroy();
          res.destroy();
        },
      });
    });
    req.on("error", reject);
    req.end();
  });
}

after(async () => {
  for (const address of spawnedAddresses.splice(0)) {
    await stopDashboard(address, { timeoutMs: 2_000 }).catch(() => {});
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ── Validation ─────────────────────────────────────────────────────────────

test("sanitizeSnapshot keeps protocol fields only and drops unrepresentable entries", () => {
  const input = makeSnapshot("session-clean") as unknown as Record<string, any>;
  input.evil = true;
  input.session.evil = "x";
  input.orchestrator.evil = 1;
  input.orchestrator.children[0].evil = "x";
  input.orchestrator.children.push({ id: "invalid-no-scope" }, { id: "child-2", scope: "ok", status: "not-a-status" });
  input.artifacts[0].evil = "x";

  const clean = sanitizeSnapshot(input);
  assert.deepEqual(Object.keys(clean).sort(), ["artifacts", "orchestrator", "session"]);
  assert.equal("evil" in clean, false);
  assert.equal("evil" in clean.session, false);
  assert.equal(clean.orchestrator.children.length, 1, "unrepresentable children are dropped, not invented");
  assert.equal("evil" in clean.orchestrator.children[0]!, false);
  assert.equal("evil" in clean.artifacts[0]!, false);
  assert.equal(({} as Record<string, unknown>).evil, undefined, "no prototype pollution");
});

test("sanitizeSnapshot rejects payloads that cannot be represented", () => {
  assert.throws(
    () => sanitizeSnapshot({ orchestrator: {} }),
    (error: unknown) => error instanceof ValidationError && error.status === 400,
  );
  assert.throws(
    () => sanitizeSnapshot({ session: { id: "../escape" } }),
    (error: unknown) => error instanceof ValidationError && error.status === 400,
  );
  const oversized = makeSnapshot("session-big", snapshot => {
    snapshot.artifacts[0]!.content = "x".repeat(MAX_ARTIFACT_BYTES + 1);
  });
  assert.throws(
    () => sanitizeSnapshot(oversized),
    (error: unknown) => error instanceof ValidationError && error.status === 413,
  );
});

test("a hostile JSON body cannot smuggle __proto__ into server state", async () => {
  await withServer({}, async ({ handle }) => {
    const snapshot = makeSnapshot("session-proto");
    const body = JSON.stringify({
      sessionId: "session-proto",
      producerId: PRODUCER_A,
      generation: 0,
      revision: 1,
      snapshot,
    }).replace('"snapshot":{', '"snapshot":{"__proto__":{"polluted":true},');
    const response = await fetch(apiUrl(handle, "api/producer/publish"), {
      method: "POST",
      headers: { authorization: `Bearer ${handle.producerToken}`, "content-type": "application/json" },
      body,
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});

// ── Browser auth ────────────────────────────────────────────────────────────

test("browser bootstrap mints an HttpOnly cookie and every browser API requires it", async () => {
  await withServer({}, async ({ handle }) => {
    assert.equal((await fetch(apiUrl(handle, "api/sessions"))).status, 401);
    assert.equal((await fetch(apiUrl(handle, "api/events"))).status, 401);
    const rejected = await fetch(`${handle.url}bootstrap?token=${"0".repeat(64)}`, { redirect: "manual" });
    assert.equal(rejected.status, 403);
    assert.equal((await fetch(apiUrl(handle, "api/health"))).status, 401);

    const cookie = await bootstrapCookie(handle);
    assert.equal((await getJson(handle, "api/sessions", cookie)).status, 200);
    assert.equal((await fetch(apiUrl(handle, "api/health"), { headers: { cookie } })).status, 200);
    assert.equal(
      (await fetch(apiUrl(handle, "api/health"), { headers: { authorization: `Bearer ${handle.producerToken}` } })).status,
      200,
    );
  });
});

test("Host and Origin are validated against this instance's loopback port", async () => {
  await withServer({}, async ({ handle }) => {
    assert.equal((await rawRequest(handle.port, "/", { headers: { host: "evil.example" } })).status, 403);
    assert.equal((await rawRequest(handle.port, "/", { headers: { host: `127.0.0.1:${handle.port + 1}` } })).status, 403);
    assert.equal((await rawRequest(handle.port, "/", { headers: { host: "localhost" } })).status, 403);
    assert.equal((await rawRequest(handle.port, "/", { headers: { origin: "http://evil.example" } })).status, 403);
    assert.equal((await rawRequest(handle.port, "/", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await rawRequest(handle.port, "/")).status, 200);
    assert.equal((await rawRequest(handle.port, "/", { headers: { host: `localhost:${handle.port}` } })).status, 200);
    assert.equal(
      (await rawRequest(handle.port, "/", { headers: { origin: `http://127.0.0.1:${handle.port}` } })).status,
      200,
    );
  });
});

// ── Projection and artifact routes ─────────────────────────────────────────

test("publish is projected into summaries and a content-free session view", async () => {
  await withServer({}, async ({ handle }) => {
    const cookie = await bootstrapCookie(handle);
    const snapshot = makeSnapshot("session-view");
    assert.equal((await publish(handle, snapshot)).status, 200);

    const sessions = (await getJson(handle, "api/sessions", cookie)).body.sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, "session-view");
    assert.equal(sessions[0].connected, true);
    assert.equal(sessions[0].revision, 1);
    assert.deepEqual(sessions[0].workers, { running: 1, total: 1 });

    const view = (await getJson(handle, "api/session?id=session-view", cookie)).body.session;
    assert.equal(view.connected, true);
    assert.equal(view.orchestrator.children[0].status, "running");
    assert.equal(view.artifacts.length, 1);
    assert.equal(view.artifacts[0].title, "Spec");
    assert.equal("content" in view.artifacts[0], false, "catalog listings never inline artifact bodies");

    const artifact = await getJson(handle, "api/artifact?session=session-view&id=artifact-1", cookie);
    assert.equal(artifact.status, 200);
    assert.equal(artifact.body.artifact.content, "# hello");
    assert.equal((await getJson(handle, "api/artifact?session=session-view&id=artifact-1&version=1", cookie)).status, 200);

    const changedVersion = await getJson(handle, "api/artifact?session=session-view&id=artifact-1&version=2", cookie);
    assert.equal(changedVersion.status, 409);
    assert.equal(changedVersion.body.version, 1);

    assert.equal((await getJson(handle, "api/artifact?session=session-view&id=missing", cookie)).status, 404);
    assert.equal((await getJson(handle, "api/artifact?session=missing&id=artifact-1", cookie)).status, 404);
    assert.equal((await getJson(handle, "api/artifact?session=session-view&id=artifact-1&version=abc", cookie)).status, 400);
    assert.equal((await getJson(handle, "api/session?id=missing", cookie)).status, 404);
    assert.equal((await getJson(handle, "api/unknown", cookie)).status, 404);
  });
});

// ── Producer transport ─────────────────────────────────────────────────────

test("producer transport authenticates separately and validates payloads", async () => {
  await withServer({}, async ({ handle }) => {
    const snapshot = makeSnapshot("session-transport");
    assert.equal((await publish(handle, snapshot, { token: "0".repeat(64) })).status, 401);
    assert.equal(
      (
        await fetch(apiUrl(handle, "api/producer/publish"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: snapshot.session.id }),
        })
      ).status,
      401,
    );
    assert.equal((await publish(handle, snapshot, { contentType: "text/plain" })).status, 415);
    assert.equal((await publish(handle, snapshot, { rawBody: "{" })).status, 400);
    const mismatched = await fetch(apiUrl(handle, "api/producer/publish"), {
      method: "POST",
      headers: { authorization: `Bearer ${handle.producerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "other-session", producerId: PRODUCER_A, generation: 0, revision: 1, snapshot }),
    });
    assert.equal(mismatched.status, 400);
    assert.equal((await getJson(handle, "api/sessions", await bootstrapCookie(handle))).body.sessions.length, 0);

    const ok = await publish(handle, snapshot);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.generation, 1);

    const postSessions = await rawRequest(handle.port, "/api/sessions", {
      method: "POST",
      headers: { cookie: await bootstrapCookie(handle) },
    });
    assert.equal(postSessions.status, 405);
  });
});

test("revisions are monotonic, generations fence replacement, and tombstones block resurrections", async () => {
  await withServer({}, async ({ handle }) => {
    const cookie = await bootstrapCookie(handle);
    const first = makeSnapshot("session-order", snapshot => {
      snapshot.session.name = "first";
    });
    assert.equal((await publish(handle, first, { revision: 2 })).status, 200);

    const stale = await publish(handle, first, { revision: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.revision, 2);

    const wrongGeneration = await publish(handle, first, { generation: 9, revision: 3 });
    assert.equal(wrongGeneration.status, 410);

    const second = makeSnapshot("session-order", snapshot => {
      snapshot.session.name = "second";
    });
    const takeover = await publish(handle, second, { producerId: PRODUCER_B, generation: 0, revision: 1 });
    assert.equal(takeover.status, 200);
    assert.equal(takeover.body.generation, 2);

    // The replaced producer cannot take the session back, even with a new high revision.
    const late = await publish(handle, first, { producerId: PRODUCER_A, generation: 1, revision: 99 });
    assert.equal(late.status, 410);
    // Nor can it resurrect after its lease is dropped from the retention sweep.
    assert.equal(await heartbeat(handle, "session-order", { producerId: PRODUCER_A, generation: 1 }), 410);
    assert.equal(await heartbeat(handle, "session-order", { producerId: PRODUCER_B, generation: 2 }), 200);

    const view = (await getJson(handle, "api/session?id=session-order", cookie)).body.session;
    assert.equal(view.session.name, "second");
    assert.equal(view.revision, 1);

    // A graceful close removes the session: its card belongs to a process that is
    // gone, and a "disconnected" ghost reads as work still in flight.
    const closed = await unregister(handle, "session-order", PRODUCER_B);
    assert.equal(closed.status, 200);
    assert.equal(closed.body.removed, true);
    const afterClose = await getJson(handle, "api/session?id=session-order", cookie);
    assert.equal(afterClose.status, 404, "a closed session is not readable after it is removed");
    const listed = await getJson(handle, "api/sessions", cookie);
    assert.equal(listed.body.sessions.some((session: any) => session.id === "session-order"), false);
    // A non-owner unregister is a no-op.
    assert.equal((await unregister(handle, "session-order", PRODUCER_A)).body.removed, false);
  });
});

test("payload and session capacity are bounded without evicting a live producer", async () => {
  await withServer({ maxSnapshotBytes: 2_048, maxSessions: 1 }, async ({ handle }) => {
    const big = makeSnapshot("session-big-body", snapshot => {
      snapshot.artifacts = [];
      snapshot.session.name = "n".repeat(4_096);
    });
    assert.equal((await publish(handle, big)).status, 413);

    const first = makeSnapshot("session-cap-1");
    assert.equal((await publish(handle, first)).status, 200);
    const second = makeSnapshot("session-cap-2");
    assert.equal((await publish(handle, second, { producerId: PRODUCER_B })).status, 429);
    const cookie = await bootstrapCookie(handle);
    assert.deepEqual(
      (await getJson(handle, "api/sessions", cookie)).body.sessions.map((session: any) => session.id),
      ["session-cap-1"],
      "a live session is never evicted to make room",
    );

    // Once the live lease lapses, its slot can be reclaimed.
    await unregister(handle, "session-cap-1");
    assert.equal((await publish(handle, second, { producerId: PRODUCER_B })).status, 200);
  });
});

// ── Static assets ───────────────────────────────────────────────────────────

async function makeWebRoot(): Promise<string> {
  const webRoot = await tempDir("pi-dash-web-");
  await mkdir(join(webRoot, "dist"), { recursive: true });
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>dashboard</title>");
  await writeFile(join(webRoot, "styles.css"), "body{color:red}");
  await writeFile(join(webRoot, "dist", "app.js"), "console.log('app')");
  await writeFile(join(webRoot, "dist", "graph.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
  await writeFile(join(webRoot, "dist", ".hidden.js"), "secret");
  await writeFile(join(webRoot, "secret.txt"), "not served");
  return webRoot;
}

test("static assets are allowlisted, traversal-safe, and carry a WASM-capable CSP", async () => {
  const webRoot = await makeWebRoot();
  await withServer({ webRoot }, async ({ handle }) => {
    const index = await rawRequest(handle.port, "/");
    assert.equal(index.status, 200);
    assert.match(index.headers["content-type"] as string, /text\/html/);
    const csp = index.headers["content-security-policy"] as string;
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
    assert.doesNotMatch(csp, /'unsafe-eval'/);

    const asset = await rawRequest(handle.port, "/assets/app.js");
    assert.equal(asset.status, 200);
    assert.match(asset.headers["content-type"] as string, /javascript/);
    assert.equal(asset.body, "console.log('app')");
    assert.equal((await rawRequest(handle.port, "/dist/app.js")).status, 200);
    assert.equal((await rawRequest(handle.port, "/styles.css")).status, 200);
    const wasm = await rawRequest(handle.port, "/assets/graph.wasm");
    assert.equal(wasm.status, 200);
    assert.match(wasm.headers["content-type"] as string, /application\/wasm/);

    assert.equal((await rawRequest(handle.port, "/assets/.hidden.js")).status, 404);
    assert.equal((await rawRequest(handle.port, "/secret.txt")).status, 404);
    assert.equal((await rawRequest(handle.port, "/assets/app.ts")).status, 404);
    // WHATWG URL parsing itself collapses `%2e%2e` dot segments, so this lands on
    // the dashboard index — proof it did not escape to a parent directory.
    const normalizedDots = await rawRequest(handle.port, "/assets/%2e%2e/index.html");
    assert.equal(normalizedDots.status, 200);
    assert.match(normalizedDots.body, /dashboard/);
    // Encoded slashes are not normalized by the URL parser; the segment check
    // rejects the traversal before any join can normalize it.
    assert.equal((await rawRequest(handle.port, "/assets/%2e%2e%2fsecret.txt")).status, 404);
    assert.equal((await rawRequest(handle.port, "/assets/..%2f..%2fetc%2fpasswd")).status, 404);
    assert.equal((await rawRequest(handle.port, "/assets/app.js", { method: "POST" })).status, 405);

    await symlink(join(REPO_ROOT, "package.json"), join(webRoot, "dist", "leak.js"));
    assert.equal((await rawRequest(handle.port, "/assets/leak.js")).status, 404, "symlinks cannot escape the web root");

    const head = await rawRequest(handle.port, "/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
  });
});

test("an unbuilt UI still answers / with a local placeholder", async () => {
  const emptyWebRoot = await tempDir("pi-dash-empty-web-");
  await withServer({ webRoot: emptyWebRoot }, async ({ handle }) => {
    const response = await rawRequest(handle.port, "/");
    assert.equal(response.status, 200);
    assert.match(response.body, /\/api\/sessions/);
  });
});

// ── SSE ────────────────────────────────────────────────────────────────────

test("SSE sends changed events, pings, caps clients, and survives a destroyed consumer", async () => {
  await withServer({ ssePingMs: 80, sseDebounceMs: 5, maxSseClients: 1 }, async ({ handle }) => {
    const cookie = await bootstrapCookie(handle);
    const stream = await openEventStream(handle.port, cookie);
    assert.equal(stream.status, 200);
    const firstChanged = await waitFor(async () => {
      const block = await stream.next(1_000).catch(() => null);
      return block && block.includes('"type":"changed"') ? block : null;
    }, "initial changed event");
    assert.match(firstChanged, /changed/);

    const unauth = await rawRequest(handle.port, "/api/events");
    assert.equal(unauth.status, 401);

    const second = await openEventStream(handle.port, cookie);
    assert.equal(second.status, 429);
    second.close();

    const ping = await waitFor(async () => {
      const block = await stream.next(500).catch(() => null);
      return block && block.startsWith(': ping') ? block : null;
    }, "SSE ping");
    assert.match(ping, /^: ping/);

    assert.equal((await publish(handle, makeSnapshot("session-sse"))).status, 200);
    const changed = await waitFor(async () => {
      const block = await stream.next(1_000).catch(() => null);
      return block && block.includes('"type":"changed"') ? block : null;
    }, "SSE changed event");
    assert.match(changed, /changed/);

    // A destroyed consumer must be removed without killing the server.
    stream.close();
    await sleep(50);
    assert.equal((await publish(handle, makeSnapshot("session-sse"), { revision: 2 })).status, 200);
    const sessions = await getJson(handle, "api/sessions", cookie);
    assert.equal(sessions.status, 200);
    assert.equal(sessions.body.sessions.length, 1);
  });
});

// ── Health, retention, idle ────────────────────────────────────────────────

test("producer liveness is separate from domain state and lapsed sessions expire", async () => {
  await withServer({ producerTtlMs: 120, retentionMs: 400 }, async ({ handle }) => {
    const cookie = await bootstrapCookie(handle);
    assert.equal((await publish(handle, makeSnapshot("session-liveness"))).status, 200);

    await waitFor(async () => {
      const sessions = (await getJson(handle, "api/sessions", cookie)).body.sessions;
      return sessions.length === 1 && sessions[0].connected === false;
    }, "producer TTL disconnect");

    const lapsed = (await getJson(handle, "api/session?id=session-liveness", cookie)).body.session;
    assert.equal(lapsed.connected, false);
    assert.equal(lapsed.orchestrator.children[0].status, "running", "disconnect is not worker failure");
    assert.equal(lapsed.revision, 1);

    assert.equal(await heartbeat(handle, "session-liveness", { generation: 1 }), 200);
    const recovered = (await getJson(handle, "api/session?id=session-liveness", cookie)).body.session;
    assert.equal(recovered.connected, true);

    await waitFor(async () => {
      const sessions = (await getJson(handle, "api/sessions", cookie)).body.sessions;
      return sessions.length === 0;
    }, "retention expiry");
  });
});

test("the server idles out when nothing is connected, and a browser holds it open", async () => {
  const runtimeDir = await tempDir();
  const handle = await startDashboardServer({ runtimeDir, preferredPort: 0, idleMs: 200 });
  const cookie = await bootstrapCookie(handle);
  const stream = await openEventStream(handle.port, cookie);
  assert.equal(stream.status, 200);

  await sleep(500);
  assert.equal((await getJson(handle, "api/sessions", cookie)).status, 200, "an open browser prevents idle shutdown");

  stream.close();
  await waitFor(async () => (await readRuntimeMetadata(runtimeDir)) === null, "idle shutdown", 4_000);
  assert.equal(await handle.closed.then(() => true), true);
});

test("a heartbeating producer keeps the server alive past the idle window", async () => {
  const runtimeDir = await tempDir();
  const handle = await startDashboardServer({ runtimeDir, preferredPort: 0, idleMs: 200, producerTtlMs: 400 });
  const producer = new DashboardProducer({ runtimeDir, heartbeatMs: 60, requestTimeoutMs: 500 });
  try {
    producer.publish(makeSnapshot("session-idle-producer"));
    await waitFor(async () => (await readRuntimeMetadata(runtimeDir)) !== null, "server start");
    const address = await readDashboardAddress(runtimeDir);
    assert.ok(address);
    spawnedAddresses.push(address);
    await sleep(600);
    assert.equal(handle.port, address.port);
    assert.equal((await fetch(apiUrl(handle, "api/health"), { headers: { authorization: `Bearer ${handle.producerToken}` } })).status, 200);
  } finally {
    await producer.close();
    await handle.close();
  }
});

// ── Singleton and lifecycle races ──────────────────────────────────────────

test("a second server for the same runtime directory loses the OS singleton", async () => {
  const runtimeDir = await tempDir();
  const first = await startDashboardServer({ runtimeDir, preferredPort: 0, idleMs: 0 });
  try {
    await assert.rejects(
      () => startDashboardServer({ runtimeDir, preferredPort: 0, idleMs: 0 }),
      (error: unknown) => error instanceof SingletonUnavailableError,
    );
    assert.equal(
      (await fetch(apiUrl(first, "api/health"), { headers: { authorization: `Bearer ${first.producerToken}` } })).status,
      200,
    );
    assert.equal((await readRuntimeMetadata(runtimeDir))?.instanceId, first.instanceId);
  } finally {
    await first.close();
  }
  // After a clean close the singleton is free again.
  const again = await startDashboardServer({ runtimeDir, preferredPort: 0, idleMs: 0 });
  assert.notEqual(again.instanceId, first.instanceId);
  await again.close();
});

test("concurrent ensureDashboard callers converge on exactly one server", async () => {
  const runtimeDir = await tempDir();
  const results = await Promise.all(
    Array.from({ length: 6 }, () => ensureDashboard({ runtimeDir, preferredPort: 0, idleMs: 0 })),
  );
  spawnedAddresses.push(results[0]!);
  assert.equal(new Set(results.map(result => result.instanceId)).size, 1);
  assert.equal(new Set(results.map(result => result.port)).size, 1);
  assert.equal(results.filter(result => result.owned).length, 1);
  assert.equal(await checkDashboardHealth(results[0]!), true);
  await stopDashboard(results[0]!);
  assert.equal(await readRuntimeMetadata(runtimeDir), null);
});

test("a fresh but still-empty lock file is never stolen (no duplicate spawn)", async () => {
  const runtimeDir = await tempDir();
  await writeFile(join(runtimeDir, LOCK_FILE), "");
  await assert.rejects(
    () => ensureDashboard({ runtimeDir, preferredPort: 0, acquireTimeoutMs: 400, lockGraceMs: 5_000 }),
    /timed out/,
  );
  assert.equal(await readRuntimeMetadata(runtimeDir), null, "no server was spawned while the lock was fresh");

  // An old lock with a dead pid is recoverable.
  await writeFile(join(runtimeDir, LOCK_FILE), JSON.stringify({ pid: 999_999, startedAt: 0 }));
  await utimes(join(runtimeDir, LOCK_FILE), new Date(0), new Date(0));
  const address = await ensureDashboard({ runtimeDir, preferredPort: 0, idleMs: 0 });
  spawnedAddresses.push(address);
  assert.equal(await checkDashboardHealth(address), true);
  await stopDashboard(address);
});

test("stale metadata is replaced, and an unrelated service on the preferred port is not adopted", async () => {
  const runtimeDir = await tempDir();
  const fakeInstance = "f".repeat(32);
  await writeFile(
    join(runtimeDir, METADATA_FILE),
    JSON.stringify({
      protocol: 1,
      instanceId: fakeInstance,
      pid: 999_999,
      host: "127.0.0.1",
      port: 1,
      url: "http://127.0.0.1:1/",
      browserUrl: "http://127.0.0.1:1/",
      startedAt: 0,
    }),
  );
  await writeFile(join(runtimeDir, "producer-token"), "a".repeat(64));

  const fromStale = await ensureDashboard({ runtimeDir, preferredPort: 0, idleMs: 0 });
  spawnedAddresses.push(fromStale);
  assert.notEqual(fromStale.instanceId, fakeInstance);
  assert.equal(await checkDashboardHealth(fromStale), true);
  await stopDashboard(fromStale);

  const occupied = createNetServer((_socket: unknown) => {});
  await new Promise<void>(resolveListen => occupied.listen(0, "127.0.0.1", resolveListen));
  const occupiedPort = (occupied.address() as AddressInfo).port;
  try {
    const address = await ensureDashboard({ runtimeDir, preferredPort: occupiedPort, idleMs: 0 });
    spawnedAddresses.push(address);
    assert.notEqual(address.port, occupiedPort, "an occupied preferred port falls back to ephemeral, never adopted");
    assert.equal(await checkDashboardHealth(address), true);
    await stopDashboard(address);
  } finally {
    await new Promise<void>(resolveClose => occupied.close(() => resolveClose()));
  }
});

test("an idled-out server restarts with a new instance when ensureDashboard is called again", async () => {
  const runtimeDir = await tempDir();
  const first = await ensureDashboard({ runtimeDir, preferredPort: 0, idleMs: 150 });
  spawnedAddresses.push(first);
  await waitFor(async () => (await readRuntimeMetadata(runtimeDir)) === null, "idle exit", 5_000);
  const second = await ensureDashboard({ runtimeDir, preferredPort: 0, idleMs: 0 });
  spawnedAddresses.push(second);
  assert.notEqual(second.instanceId, first.instanceId);
  assert.equal(await checkDashboardHealth(second), true);
  await stopDashboard(second);
});

test("importing lifecycle has no startup side effects, and server args are allowlisted", async () => {
  const runtimeDir = await tempDir();
  assert.equal(await readDashboardAddress(runtimeDir), null);
  assert.equal(await readRuntimeMetadata(runtimeDir), null);
  assert.deepEqual(await readdirSafe(runtimeDir), []);

  assert.throws(() => parseServerArgs(["--runtime-dir", "/tmp/x", "--bogus", "1"]), /unknown flag/);
  assert.throws(() => parseServerArgs(["--runtime-dir", "/tmp/x", "--preferred-port", "-1"]), /invalid --preferred-port/);
  const parsed = parseServerArgs(["--runtime-dir=/tmp/dash", "--preferred-port=0", "--idle-ms", "300"]);
  assert.equal(parsed.options.runtimeDir, "/tmp/dash");
  assert.equal(parsed.options.preferredPort, 0);
  assert.equal(parsed.options.idleMs, 300);
  assert.ok(defaultRuntimeDir().length > 0);
});

async function readdirSafe(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

// ── Producer client: real server ───────────────────────────────────────────

test("DashboardProducer is lazy, coalesces a burst, and re-notifies on a new URL", async () => {
  const runtimeDir = await tempDir();
  const ready: string[] = [];
  const errors: unknown[] = [];
  const producer = new DashboardProducer({
    runtimeDir,
    heartbeatMs: 100,
    onReady: url => ready.push(url),
    onError: error => errors.push(error),
  });
  try {
    assert.equal(await readRuntimeMetadata(runtimeDir), null, "constructing a producer starts nothing");
    producer.publish(makeSnapshot("session-producer"));
    await waitFor(async () => (await readRuntimeMetadata(runtimeDir)) !== null && ready.length === 1, "lazy server start");
    const address = await readDashboardAddress(runtimeDir);
    assert.ok(address);
    spawnedAddresses.push(address);
    assert.match(ready[0]!, /\/bootstrap\?token=/);

    const cookie = await bootstrapCookie(address);
    await waitFor(async () => (await getJson(address, "api/sessions", cookie)).body.sessions.length === 1, "first publish");
    for (let index = 2; index <= 25; index += 1) {
      producer.publish(
        makeSnapshot("session-producer", snapshot => {
          snapshot.session.name = `burst-${index}`;
        }),
      );
    }
    const coalesced = await waitFor(async () => {
      const sessions = (await getJson(address, "api/sessions", cookie)).body.sessions;
      return sessions[0]?.name === "burst-25" ? sessions[0] : null;
    }, "coalesced burst");
    assert.ok(coalesced.revision <= 5, `coalesced revisions should stay small, got ${coalesced.revision}`);
    assert.deepEqual(errors, []);

    await producer.close();
    const remaining = await waitFor(async () => {
      const sessions = (await getJson(address, "api/sessions", cookie)).body.sessions;
      return sessions.length === 0 ? sessions : null;
    }, "graceful close removes the session card");
    assert.deepEqual(remaining, []);
  } finally {
    await producer.close();
    await stopDashboardByRuntimeDirSafe(runtimeDir);
  }
});

async function stopDashboardByRuntimeDirSafe(runtimeDir: string): Promise<void> {
  const address = await readDashboardAddress(runtimeDir);
  if (address) await stopDashboard(address);
}

test("a producer that starts with an invalid snapshot reports instead of throwing", async () => {
  const runtimeDir = await tempDir();
  const errors: unknown[] = [];
  const producer = new DashboardProducer({ runtimeDir, onError: error => errors.push(error) });
  try {
    assert.doesNotThrow(() => producer.publish({} as DashboardSnapshot));
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof ValidationError);
    assert.equal(await readRuntimeMetadata(runtimeDir), null);
  } finally {
    await producer.close();
  }
});

// ── Producer client: transport regressions (mock server) ───────────────────

interface MockResponse {
  status: number;
  body: Record<string, unknown>;
}

interface MockTransport {
  ensure: () => Promise<DashboardAddress>;
  fetchImpl: typeof fetch;
  requests: Array<{ url: string; body: any }>;
  ensureCalls: () => number;
}

function mockTransport(responder: (request: { url: string; body: any }, index: number) => MockResponse | Error): MockTransport {
  const requests: Array<{ url: string; body: any }> = [];
  let ensureCalls = 0;
  const address: DashboardAddress = {
    url: "http://127.0.0.1:1/",
    browserUrl: "http://127.0.0.1:1/bootstrap?token=first",
    port: 1,
    pid: process.pid,
    runtimeDir: "/tmp/mock-dashboard",
    instanceId: "m".repeat(32),
    producerToken: "b".repeat(64),
    protocol: 1,
    owned: true,
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body === undefined ? null : JSON.parse(String(init.body));
    requests.push({ url, body });
    const response = responder({ url, body }, requests.length - 1);
    if (response instanceof Error) throw response;
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    ensure: async () => {
      ensureCalls += 1;
      return address;
    },
    fetchImpl,
    requests,
    ensureCalls: () => ensureCalls,
  };
}

test("a 409 after a lost ACK resends the newest snapshot above the server revision", async () => {
  const transport = mockTransport((_request, index) => {
    if (index === 0) return new Error("socket closed after the server applied the snapshot");
    if (index === 1) return { status: 409, body: { error: "stale revision", revision: 1, generation: 1 } };
    return { status: 200, body: { generation: 1, revision: 2, accepted: true } };
  });
  const errors: unknown[] = [];
  const producer = new DashboardProducer({
    ensure: transport.ensure,
    fetchImpl: transport.fetchImpl,
    heartbeatMs: 0,
    retryBaseMs: 60,
    retryMaxMs: 120,
    onError: error => errors.push(error),
  });
  try {
    producer.publish(makeSnapshot("session-lost-ack", snapshot => (snapshot.session.name = "A")));
    await waitFor(async () => transport.requests.length >= 1, "first publish attempt");
    // Snapshot B replaces A while A's ACK is lost; B must not be dropped.
    producer.publish(makeSnapshot("session-lost-ack", snapshot => (snapshot.session.name = "B")));
    await waitFor(async () => transport.requests.length >= 3, "resend after 409", 4_000);

    assert.equal(transport.requests[1]!.body.snapshot.session.name, "B");
    assert.equal(transport.requests[1]!.body.revision, 1);
    const resent = transport.requests[2]!;
    assert.equal(resent.body.revision, 2, "adopts the server revision and resends one above it");
    assert.equal(resent.body.snapshot.session.name, "B", "the newest pending snapshot is what gets resent");
    assert.ok(errors.some(error => String(error).includes("socket closed")));
    await sleep(120);
    assert.equal(transport.requests.length, 3, "no extra resend after the latest snapshot is accepted");
  } finally {
    await producer.close();
  }
});

test("a failed heartbeat re-arms discovery instead of leaving the producer dead", async () => {
  let heartbeats = 0;
  const transport = mockTransport(request => {
    if (request.url.endsWith("/api/producer/heartbeat")) {
      heartbeats += 1;
      return new Error("connection refused");
    }
    return { status: 200, body: { generation: 1, revision: 1, accepted: true } };
  });
  const producer = new DashboardProducer({
    ensure: transport.ensure,
    fetchImpl: transport.fetchImpl,
    heartbeatMs: 20,
    retryBaseMs: 5,
    retryMaxMs: 20,
  });
  try {
    producer.publish(makeSnapshot("session-heartbeat"));
    // Monotonic: a heartbeat request (heartbeatMs: 20) can land before this check
    // runs, so an exact `requests.length === 1` would race the producer it is
    // testing. Assert that discovery ran and a publish was actually sent.
    await waitFor(
      async () => transport.ensureCalls() >= 1
        && transport.requests.some(request => request.url.endsWith("/api/producer/publish")),
      "initial publish",
    );
    await waitFor(async () => heartbeats > 0, "heartbeat attempt", 3_000);
    await waitFor(async () => transport.ensureCalls() >= 2, "discovery re-armed after heartbeat failure", 4_000);
    await waitFor(
      async () => transport.requests.filter(request => request.url.endsWith("/api/producer/publish")).length >= 2,
      "snapshot republished after heartbeat failure",
      4_000,
    );
    assert.equal(producer.superseded, false);
  } finally {
    await producer.close();
  }
});

test("onReady re-notifies when the server restarts on a new URL", async () => {
  let url = "http://127.0.0.1:1/bootstrap?token=first";
  const ready: string[] = [];
  let phase = 0;
  const transport = mockTransport(request => {
    if (request.url.endsWith("/api/producer/publish")) {
      phase += 1;
      if (phase === 1) return { status: 200, body: { generation: 1, revision: 1, accepted: true } };
      if (phase < 4) return new Error("server gone");
      return { status: 200, body: { generation: 1, revision: 2, accepted: true } };
    }
    return { status: 200, body: { ok: true } };
  });
  const ensure = async (): Promise<DashboardAddress> => {
    const address = await transport.ensure();
    if (ready.length > 0) url = "http://127.0.0.1:2/bootstrap?token=second";
    return { ...address, url: "http://127.0.0.1:2/", browserUrl: url, port: 2 };
  };
  const producer = new DashboardProducer({
    ensure,
    fetchImpl: transport.fetchImpl,
    heartbeatMs: 0,
    retryBaseMs: 5,
    retryMaxMs: 10,
    onReady: value => ready.push(value),
  });
  try {
    producer.publish(makeSnapshot("session-renotify"));
    await waitFor(async () => ready.length === 1 && transport.requests.length === 1, "first ready");
    producer.publish(makeSnapshot("session-renotify", snapshot => (snapshot.session.name = "after-restart")));
    await waitFor(async () => ready.length === 2, "second ready after restart", 4_000);
    assert.match(ready[0]!, /token=first/);
    assert.match(ready[1]!, /token=second/);
  } finally {
    await producer.close();
  }
});

test("supersede stops publishing and close stops retry timers", async () => {
  const transport = mockTransport(() => ({ status: 410, body: { error: "superseded" } }));
  const errors: unknown[] = [];
  const producer = new DashboardProducer({
    ensure: transport.ensure,
    fetchImpl: transport.fetchImpl,
    heartbeatMs: 20,
    retryBaseMs: 5,
    retryMaxMs: 10,
    onError: error => errors.push(error),
  });
  producer.publish(makeSnapshot("session-superseded"));
  await waitFor(async () => producer.superseded, "superseded");
  const callsAfterSupersede = transport.requests.length;
  producer.publish(makeSnapshot("session-superseded", snapshot => (snapshot.session.name = "ignored")));
  await sleep(80);
  assert.equal(transport.requests.length, callsAfterSupersede, "a superseded producer does not publish again");
  assert.ok(errors.some(error => String(error).includes("superseded")));
  await producer.close();
  await assert.doesNotReject(() => producer.close());
});

test("a producer with an unreachable server retries and recovers", async () => {
  let attempts = 0;
  const transport = mockTransport(() => {
    attempts += 1;
    if (attempts <= 2) return new Error("ECONNREFUSED");
    return { status: 200, body: { generation: 1, revision: 1, accepted: true } };
  });
  const producer = new DashboardProducer({
    ensure: transport.ensure,
    fetchImpl: transport.fetchImpl,
    heartbeatMs: 0,
    retryBaseMs: 5,
    retryMaxMs: 20,
  });
  try {
    producer.publish(makeSnapshot("session-retry"));
    await waitFor(async () => attempts >= 3, "publish recovery", 4_000);
    assert.ok(transport.ensureCalls() >= 2, "discovery is retried after each transport failure");
  } finally {
    await producer.close();
  }
});
