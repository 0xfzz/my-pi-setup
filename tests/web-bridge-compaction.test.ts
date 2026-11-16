// Compaction feedback for a session the TUI owns.
//
// An in-process session (one this server started) reports compaction through
// its own pi events, which web/core/server/wire.ts projects. A bridged session
// has no such stream: the events exist only in the terminal's process, so the
// extension has to forward them, in the same shape, or the browser shows a
// live status for one kind of session and not the other.
//
// The forwarding has one dangerous edge: `session_before_compact` is a
// *before* event. Pi cancels the compaction when a handler returns
// `{ cancel: true }`, so a listener that returns anything truthy silently
// breaks /compact — including the extension-provided compactor this repo's VCC
// patch relies on. These tests pin both halves: the events are forwarded, and
// the before-handler stays out of the way.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

const SESSION_ID = "bridge-compaction-session";

interface FakeBridge {
  url: string;
  /** Events the extension posted to `/api/bridge/:id/events`. */
  events: Array<Record<string, unknown>>;
  /** State snapshots that landed — the first one proves the bridge attached. */
  states: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

async function startFakeBridgeServer(): Promise<FakeBridge> {
  let attached = false;
  const events: Array<Record<string, unknown>> = [];
  const states: Array<Record<string, unknown>> = [];
  const streams: ServerResponse[] = [];
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (path === `/api/bridge/${SESSION_ID}/attach`) {
      // The real server registers the bridge in the tick it writes this
      // response; a post that arrives before that is refused.
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
          events?: Array<Record<string, unknown>>;
          state?: Record<string, unknown>;
        };
        if (!attached) {
          res.writeHead(404, { "Content-Type": "application/json", Connection: "close" });
          res.end(JSON.stringify({ error: "Bridge not attached" }));
          return;
        }
        events.push(...(body.events ?? []));
        if (body.state !== undefined) states.push(body.state);
        res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404, { Connection: "close" });
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    events,
    states,
    async close() {
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the bridge events");
}

interface AttachedExtension {
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
  stop(): void;
}

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
  const mockCtx = {
    cwd: process.cwd(),
    hasUI: false,
    model: { provider: "fake", id: "fake-model" },
    thinkingLevel: "off",
    isIdle: () => true,
    getContextUsage: () => ({ percent: 10, contextWindow: 200_000, tokens: 20_000 }),
    sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => undefined },
    ui: { notify: () => undefined, setStatus: () => undefined },
  };

  const { default: webExtension } = await import("../extensions/web.ts");
  webExtension(mockPi as never, { autoReload: false });

  const onSessionStart = handlers.get("session_start");
  assert.ok(onSessionStart !== undefined, "the extension registers session_start");
  onSessionStart({ type: "session_start", reason: "new" }, mockCtx);

  return {
    handlers,
    stop: () => {
      handlers.get("session_shutdown")?.({ type: "session_shutdown" }, mockCtx);
    },
  };
}

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
    extension?.stop();
    if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = testContext;
    delete process.env.PI_WEB_URL;
    await bridge.close();
  }
}

test("a bridged session forwards pi's own compaction, start and end", async () => {
  await withBridgedExtension(async (bridge, extension) => {
    // The attach snapshot proves the bridge (and with it the event poster) is
    // live; before that the extension has nowhere to post.
    await waitFor(() => bridge.states.length > 0);

    const before = extension.handlers.get("session_before_compact");
    assert.ok(before !== undefined, "session_before_compact is observed");

    // Returning nothing is the contract that matters: `{ cancel: true }` — or
    // any truthy result — would cancel the compaction the browser asked for.
    const result = before({ type: "session_before_compact", reason: "manual" }, {});
    assert.equal(result, undefined, "the before-handler never cancels a compaction");

    extension.handlers.get("session_compact")?.({
      type: "session_compact",
      reason: "manual",
      willRetry: false,
      fromExtension: false,
      compactionEntry: { type: "compaction", summary: "s", tokensBefore: 128_000 },
    }, {});

    await waitFor(() => bridge.events.some((event) => event.type === "compaction_end"));
    assert.deepEqual(
      bridge.events.filter((event) => String(event.type).startsWith("compaction")),
      [
        { type: "compaction_start", reason: "manual" },
        { type: "compaction_end", reason: "manual", aborted: false, willRetry: false, tokensBefore: 128_000 },
      ],
    );
  });
});

test("a bridged session forwards a failed or cancelled compaction", async () => {
  await withBridgedExtension(async (bridge, extension) => {
    await waitFor(() => bridge.states.length > 0);
    extension.handlers.get("session_before_compact")?.({
      type: "session_before_compact",
      reason: "overflow",
    }, {});
    extension.handlers.get("session_compact_failed")?.({
      type: "session_compact_failed",
      reason: "overflow",
      aborted: false,
      willRetry: false,
      errorMessage: "Context overflow recovery failed: session too small",
    }, {});

    await waitFor(() => bridge.events.some((event) => event.type === "compaction_end"));
    assert.deepEqual(
      bridge.events.filter((event) => String(event.type).startsWith("compaction")),
      [
        { type: "compaction_start", reason: "overflow" },
        {
          type: "compaction_end",
          reason: "overflow",
          aborted: false,
          willRetry: false,
          errorMessage: "Context overflow recovery failed: session too small",
        },
      ],
    );

    // A cancelled compaction is aborted, not failed: the browser clears its
    // status and shows no error row.
    extension.handlers.get("session_compact_failed")?.({
      type: "session_compact_failed",
      reason: "threshold",
      aborted: true,
      willRetry: false,
    }, {});
    await waitFor(() =>
      bridge.events.some((event) => event.type === "compaction_end" && event.reason === "threshold")
    );
    assert.deepEqual(
      bridge.events.filter((event) => event.reason === "threshold").at(-1),
      { type: "compaction_end", reason: "threshold", aborted: true, willRetry: false },
    );
  });
});
