import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

/**
 * A detached bridge must stay detached.
 *
 * `stopBridge` (a `session_shutdown`, a `/web stop`) aborts the attach
 * stream, which ends the retry loop. The loop used to arm the self-heal
 * watchdog *before* checking the abort, so a stopped bridge left a live
 * watchdog behind: five seconds later it re-attached the session the user had
 * just detached — to whatever `PI_WEB_URL` pointed at by then, which can be a
 * different server than the one the bridge belonged to.
 *
 * The attach itself had the same hole: an attach awaiting the health check or
 * the attach response when the stop landed would carry on and revive the
 * bridge. Both are closed by the attach generation.
 */

interface FakeBridge {
  /** The URL the extension must talk to (`PI_WEB_URL`). */
  url: string;
  /** Attach streams the extension opened. */
  attachCount(): number;
  close(): Promise<void>;
}

const SESSION_ID = "bridge-shutdown-session";
/** The self-heal watchdog's cadence; a re-attach can only appear after this. */
const WATCHDOG_TICK_MS = 5_000;

async function startFakeBridgeServer(): Promise<FakeBridge> {
  let attachCount = 0;
  const streams: ServerResponse[] = [];
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (path === `/api/bridge/${SESSION_ID}/attach`) {
      attachCount++;
      // The attach response stays open, like a real bridge stream.
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(":\n\n");
      streams.push(res);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    attachCount: () => attachCount,
    async close() {
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

test("a detached bridge does not re-attach itself", async () => {
  const bridge = await startFakeBridgeServer();
  // The extension's bridge gate: it never bridges under the test runner, so
  // this test opts in and points it at the fake server.
  const testContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  process.env.PI_WEB_URL = bridge.url;

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
    getContextUsage: () => ({ percent: 0, contextWindow: 200_000, tokens: 0 }),
    sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => undefined },
    ui: { notify: () => undefined, setStatus: () => undefined },
  };

  try {
    const { default: webExtension } = await import("../extensions/web.ts");
    webExtension(mockPi as never, { autoReload: false });
    handlers.get("session_start")?.({ type: "session_start", reason: "new" }, mockCtx);

    // Wait for the attach to land before detaching, so the stop hits a live
    // bridge rather than racing the attach.
    const deadline = Date.now() + 5_000;
    while (bridge.attachCount() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(bridge.attachCount(), 1, "the session attached once");

    handlers.get("session_shutdown")?.({ type: "session_shutdown" }, mockCtx);

    // Past the watchdog's first tick: a re-attach here means the stop left
    // the self-heal armed.
    await new Promise((resolve) => setTimeout(resolve, WATCHDOG_TICK_MS + 600));
    assert.equal(bridge.attachCount(), 1, "a detached bridge must not re-attach");
  } finally {
    if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = testContext;
    await bridge.close();
  }
});
