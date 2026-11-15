import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

/**
 * A dialog answer posted from the web must reach the extension that owns the
 * dialog, whichever frontend started the session.
 *
 * The providers plugin publishes rows that carry their target in the action's
 * `values` (`{ providerId }`, `{ modelId }`, a form's field answers). An
 * in-process session relays those values straight onto the extension's event
 * bus. A bridged session — a pi started in the TUI, attached by the web — takes
 * the long way round: the action route emits the request on the bridge's action
 * bus, the bridge forwards it as a `bridge_command`, and this extension
 * re-emits it on `pi.events`. That last hop dropped `values`, so every row
 * click on the providers page answered 200 and then did nothing: the manager
 * had no provider id, no screen, and published no view. Sessions differed only
 * by how they were started, which is what made the bug look random.
 *
 * These tests drive the real extension against a fake bridge server and push
 * `action` commands down the attach stream, exactly as the server does.
 */

interface FakeBridge {
  url: string;
  states: Array<Record<string, unknown>>;
  sendCommand(command: Record<string, unknown>): void;
  close(): Promise<void>;
}

const SESSION_ID = "bridge-action-values-session";

async function startFakeBridgeServer(): Promise<FakeBridge> {
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
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(":\n\n");
      streams.push(res);
      return;
    }
    if (path === `/api/bridge/${SESSION_ID}/events`) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          state?: Record<string, unknown>;
        };
        if (body.state !== undefined) states.push(body.state);
        res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
        res.end(JSON.stringify({ ok: true }));
      });
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
    states,
    sendCommand(command: Record<string, unknown>) {
      const frame = { type: "bridge_command", command };
      for (const stream of streams) stream.write(`data: ${JSON.stringify(frame)}\n\n`);
    },
    async close() {
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the bridge");
}

interface Harness {
  /** Every action request the extension re-emitted on pi.events, in order. */
  requests: Array<Record<string, unknown>>;
  stop(): void;
}

/** Load the real extension and capture the action requests it re-emits. */
async function attachExtension(): Promise<Harness> {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const requests: Array<Record<string, unknown>> = [];
  const mockPi = {
    registerCommand: () => undefined,
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    },
    getCommands: () => [],
    events: {
      emit: (channel: string, payload: unknown) => {
        if (channel === "web-plugin:action-request") requests.push(payload as Record<string, unknown>);
      },
      on: () => () => undefined,
    },
    setModel: async () => true,
    setThinkingLevel: () => undefined,
  };
  const mockCtx = {
    cwd: process.cwd(),
    hasUI: false,
    model: { provider: "p", id: "m" },
    thinkingLevel: "off",
    isIdle: () => true,
    getContextUsage: () => null,
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => undefined },
    ui: { notify: () => undefined, setStatus: () => undefined },
  };

  const { default: webExtension } = await import("../extensions/web.ts");
  webExtension(mockPi as never, { autoReload: false });
  const onSessionStart = handlers.get("session_start");
  assert.ok(onSessionStart !== undefined, "the extension registers session_start");
  onSessionStart({ type: "session_start", reason: "new" }, mockCtx);

  return {
    requests,
    stop: () => {
      handlers.get("session_shutdown")?.({ type: "session_shutdown" }, mockCtx);
    },
  };
}

async function withBridgedExtension(
  fn: (bridge: FakeBridge, harness: Harness) => Promise<void>,
): Promise<void> {
  const bridge = await startFakeBridgeServer();
  const testContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  process.env.PI_WEB_URL = bridge.url;
  let harness: Harness | null = null;
  try {
    harness = await attachExtension();
    await fn(bridge, harness);
  } finally {
    harness?.stop();
    if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = testContext;
    delete process.env.PI_WEB_URL;
    await bridge.close();
  }
}

test("a bridged session forwards a dialog row's values", async () => {
  await withBridgedExtension(async (bridge, harness) => {
    await waitFor(() => bridge.states.length > 0);

    bridge.sendCommand({
      type: "action",
      requestId: "req-values-1",
      pluginId: "providers",
      actionId: "provider-manage",
      confirm: "OpenRouter (openrouter)",
      values: { providerId: "openrouter" },
    });

    await waitFor(() => harness.requests.length > 0);
    assert.deepEqual(
      harness.requests[0]?.values,
      { providerId: "openrouter" },
      "the provider id is the whole answer: without it the manager cannot open",
    );
    assert.equal(harness.requests[0]?.actionId, "provider-manage");
    assert.equal(harness.requests[0]?.confirm, "OpenRouter (openrouter)");
  });
});

test("a form submission keeps every field of the answer", async () => {
  await withBridgedExtension(async (bridge, harness) => {
    await waitFor(() => bridge.states.length > 0);

    bridge.sendCommand({
      type: "action",
      requestId: "req-values-2",
      pluginId: "providers",
      actionId: "provider-manage",
      confirm: "Save connection",
      values: { name: "OpenRouter", api: "openai-completions", baseUrl: "https://example.test/v1", apiKey: "" },
    });

    await waitFor(() => harness.requests.length > 0);
    assert.deepEqual(harness.requests[0]?.values, {
      name: "OpenRouter",
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      apiKey: "",
    });
  });
});

test("an action with no values stays a confirm-only request", async () => {
  await withBridgedExtension(async (bridge, harness) => {
    await waitFor(() => bridge.states.length > 0);

    bridge.sendCommand({
      type: "action",
      requestId: "req-values-3",
      pluginId: "providers",
      actionId: "provider-next",
      confirm: "Continue",
    });

    await waitFor(() => harness.requests.length > 0);
    assert.equal("values" in (harness.requests[0] ?? {}), false, "an absent answer must not become an empty object");
  });
});
