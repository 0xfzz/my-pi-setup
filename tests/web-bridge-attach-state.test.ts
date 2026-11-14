import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

/**
 * The web's context-window bar rendered em-dashes for a whole session until
 * the first turn settled.
 *
 * The bar draws dashes only when the client has no reading, and for a session
 * the TUI owns the reading comes from the bridge's cached state — which starts
 * as `contextUsage: null` and is filled *only* by the extension's state post.
 * (The model chip is unaffected because it falls back to the attach metadata.)
 *
 * The extension posted that snapshot before opening the attach stream. The
 * server has no bridge until the attach arrives, so `POST
 * /api/bridge/:id/events` answered 404 and the snapshot was dropped: the
 * figure stayed dashed until `agent_settled` posted again after a turn.
 *
 * These tests drive the real extension against a fake bridge server that keeps
 * the real contract — the bridge exists only once the attach response is
 * written, and a state post for a bridge-less session is refused.
 */

interface FakeBridge {
  /** The URL the extension must talk to (`PI_WEB_URL`). */
  url: string;
  /** State snapshots that landed (accepted after the attach). */
  states: Array<Record<string, unknown>>;
  /** State posts refused because no bridge existed yet. */
  rejectedStates: number;
  /** Push a bridge command down the attach stream, as the server does. */
  sendCommand(command: Record<string, unknown>): void;
  close(): Promise<void>;
}

const SESSION_ID = "bridge-attach-state-session";

async function startFakeBridgeServer(): Promise<FakeBridge> {
  let attached = false;
  const states: Array<Record<string, unknown>> = [];
  const streams: ServerResponse[] = [];
  let rejectedStates = 0;
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (path === `/api/bridge/${SESSION_ID}/attach`) {

      // The real server registers the bridge in the same tick it writes this
      // response, so the bridge exists only once the response has been sent.
      // The short hold keeps a post issued before the attach from slipping in
      // ahead of it, which would make the ordering a socket race.
      setTimeout(() => {
        attached = true;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(":\n\n");
        streams.push(res);
      }, 10);
      return;
    }
    if (path === `/api/bridge/${SESSION_ID}/events`) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          state?: Record<string, unknown>;
        };
        if (body.state !== undefined) {
          if (!attached) {
            // Exactly what web/core/server/routes.ts answers for a session
            // with no bridge — the drop these tests guard against.
            rejectedStates++;
            res.writeHead(404, { "Content-Type": "application/json", Connection: "close" });
            res.end(JSON.stringify({ error: "Bridge not attached" }));
            return;
          }
          states.push(body.state);
        }
        res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    // detach and anything else the extension touches.
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    states,
    get rejectedStates() {
      return rejectedStates;
    },
    sendCommand(command: Record<string, unknown>) {
      // The server's frame shape, not a bare command: the extension ignores
      // anything that is not a `bridge_command`.
      const frame = { type: "bridge_command", command };
      for (const stream of streams) stream.write(`data: ${JSON.stringify(frame)}\n\n`);
    },
    async close() {
      // End the attach streams the extension is still reading, then drop
      // every socket so no handle outlives the test.
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  } as FakeBridge;
}

/** Poll until `check` holds, so a test never sleeps a fixed span. */
async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the bridge state post");
}

const CONTEXT_USAGE = { percent: 42, contextWindow: 200_000, tokens: 84_000 };

interface AttachedExtension {
  /** Re-point the session's reading, as a turn would. */
  setUsage(usage: { percent: number; contextWindow: number; tokens: number }): void;
  stop(): void;
}

/**
 * Load the real extension and attach a session to it. The caller has already
 * opened the bridge gate and pointed `PI_WEB_URL` at the fake server.
 */
async function attachExtension(): Promise<AttachedExtension> {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const mockPi = {
    registerCommand: () => undefined,
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    },
    getCommands: () => [],
    events: { emit: () => undefined, on: () => () => undefined },
    setModel: async () => true,
    setThinkingLevel: () => undefined,
  };
  let usage = CONTEXT_USAGE;
  const mockCtx = {
    cwd: process.cwd(),
    hasUI: false,
    model: { provider: "fake", id: "fake-model" },
    thinkingLevel: "off",
    isIdle: () => true,
    getContextUsage: () => usage,
    sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => undefined },
    ui: { notify: () => undefined, setStatus: () => undefined },
  };

  const { default: webExtension } = await import("../extensions/web.ts");
  // No source watcher: these tests are about the bridge attach sequence.
  webExtension(mockPi as never, { autoReload: false });

  const onSessionStart = handlers.get("session_start");
  assert.ok(onSessionStart !== undefined, "the extension registers session_start");
  onSessionStart({ type: "session_start", reason: "new" }, mockCtx);

  return {
    setUsage: (next) => {
      usage = next;
    },
    stop: () => {
      handlers.get("session_shutdown")?.({ type: "session_shutdown" }, mockCtx);
    },
  };
}

/** Run `fn` with the bridge gate open and `PI_WEB_URL` pointed at the fake. */
async function withBridgedExtension(
  fn: (bridge: FakeBridge, extension: AttachedExtension) => Promise<void>,
): Promise<void> {
  const bridge = await startFakeBridgeServer();
  const testContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  process.env.PI_WEB_URL = bridge.url;
  let extension: AttachedExtension | null = null;
  try {
    extension = await attachExtension();
    await fn(bridge, extension);
  } finally {
    // The bridge loop reconnects forever by design: stop it before the fake
    // server goes away, or its retry timer outlives the test.
    extension?.stop();
    if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = testContext;
    delete process.env.PI_WEB_URL;
    await bridge.close();
  }
}

test("the bridge state snapshot lands after the attach stream opens", async () => {
  await withBridgedExtension(async (bridge) => {
    await waitFor(() => bridge.states.length > 0);

    assert.deepEqual(
      bridge.states[0]?.contextUsage,
      CONTEXT_USAGE,
      "the snapshot the server caches carries the session's context usage",
    );
    assert.equal(
      bridge.rejectedStates,
      0,
      "no state post may be sent before the bridge exists",
    );
  });
});

test("a ui sync re-posts the snapshot, so a late consumer converges", async () => {
  await withBridgedExtension(async (bridge, extension) => {
    await waitFor(() => bridge.states.length > 0);

    // A turn moved the reading; the server then asks every session to
    // re-emit its current values (the ui-sync it sends when a bridge or a
    // consumer attaches).
    const afterTurn = { percent: 61, contextWindow: 200_000, tokens: 122_000 };
    extension.setUsage(afterTurn);
    bridge.sendCommand({ type: "ui_sync" });

    await waitFor(() =>
      bridge.states.some((state) => (state.contextUsage as { tokens?: number } | undefined)?.tokens === afterTurn.tokens)
    );
    assert.deepEqual(
      bridge.states.filter((state) => (state.contextUsage as { tokens?: number } | undefined)?.tokens === afterTurn.tokens)[0]
        ?.contextUsage,
      afterTurn,
      "the ui sync re-reads the session's context usage instead of replaying a stale one",
    );
  });
});
