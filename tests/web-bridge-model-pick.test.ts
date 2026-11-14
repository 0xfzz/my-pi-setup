import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

/**
 * The web model picker offered every model but only resolved the scoped ones.
 *
 * With `enabledModels` configured the session has a non-empty scope, so the
 * extension posted the scope as the picker's default list and the full
 * catalogue as its "All models" tab. The `set_model` command resolved the
 * picked `provider/id` against the *scope* only, so a pick from the All tab
 * answered `model not found: …` while the web had already shown the optimistic
 * chip — the chip then snapped back to the previous model on the next state
 * push. The TUI never had the bug because its selector hands over the resolved
 * Model object from the full available snapshot.
 *
 * These tests drive the real extension against a fake bridge server and push
 * `set_model` commands down the attach stream, exactly as the server does.
 */

interface FakeBridge {
  url: string;
  states: Array<Record<string, unknown>>;
  sendCommand(command: Record<string, unknown>): void;
  close(): Promise<void>;
}

const SESSION_ID = "bridge-model-pick-session";

interface ModelRef {
  provider: string;
  id: string;
}

const SCOPED: ModelRef = { provider: "scoped-provider", id: "scoped-model" };
const UNSCOPED: ModelRef = { provider: "other-provider", id: "other-model" };
const AVAILABLE: ModelRef[] = [SCOPED, UNSCOPED];

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
  /** Every `pi.setModel` argument, in call order. */
  applied: ModelRef[];
  /** Every message the extension raised; a success is `model: <provider>/<id>`. */
  notices: string[];
  stop(): void;
}

/** The notices that report a problem: everything but the applied-model line. */
function problemsOf(harness: Harness): string[] {
  return harness.notices.filter((notice) => !/^model: \S+$/.test(notice));
}

/** Load the real extension over a session that has a non-empty model scope. */
async function attachExtension(): Promise<Harness> {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const applied: ModelRef[] = [];
  const notices: string[] = [];
  const mockPi = {
    registerCommand: () => undefined,
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    },
    getCommands: () => [],
    events: { emit: () => undefined, on: () => () => undefined },
    setModel: async (model: ModelRef) => {
      applied.push({ provider: model.provider, id: model.id });
      return true;
    },
    setThinkingLevel: () => undefined,
  };
  const models = AVAILABLE.map((ref) => ({ ...ref }));
  const mockCtx = {
    cwd: process.cwd(),
    hasUI: false,
    model: models[0],
    scopedModels: [{ model: models[0] }],
    thinkingLevel: "off",
    isIdle: () => true,
    getContextUsage: () => null,
    modelRegistry: {
      getAvailable: () => models,
      find: (provider: string, id: string) =>
        models.find((candidate) => candidate.provider === provider && candidate.id === id),
    },
    sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => undefined },
    ui: {
      notify: (message: string) => notices.push(message),
      setStatus: () => undefined,
    },
  };

  const { default: webExtension } = await import("../extensions/web.ts");
  webExtension(mockPi as never, { autoReload: false });
  const onSessionStart = handlers.get("session_start");
  assert.ok(onSessionStart !== undefined, "the extension registers session_start");
  onSessionStart({ type: "session_start", reason: "new" }, mockCtx);

  return {
    applied,
    notices,
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

test("a pick from the picker's All tab applies, even outside the model scope", async () => {
  await withBridgedExtension(async (bridge, harness) => {
    await waitFor(() => bridge.states.length > 0);

    bridge.sendCommand({ type: "set_model", provider: UNSCOPED.provider, id: UNSCOPED.id });

    await waitFor(() => harness.applied.length > 0 || problemsOf(harness).length > 0);
    assert.deepEqual(
      harness.applied,
      [UNSCOPED],
      "the picker offers the full catalogue, so a pick outside the scope must still resolve",
    );
    assert.deepEqual(problemsOf(harness), [], "a resolvable pick must not warn");
  });
});

test("a scoped pick still applies", async () => {
  await withBridgedExtension(async (bridge, harness) => {
    await waitFor(() => bridge.states.length > 0);

    bridge.sendCommand({ type: "set_model", provider: SCOPED.provider, id: SCOPED.id });

    await waitFor(() => harness.applied.length > 0 || problemsOf(harness).length > 0);
    assert.deepEqual(harness.applied, [SCOPED]);
    assert.deepEqual(problemsOf(harness), []);
  });
});

test("an unknown model is still reported as not found", async () => {
  await withBridgedExtension(async (bridge, harness) => {
    await waitFor(() => bridge.states.length > 0);

    bridge.sendCommand({ type: "set_model", provider: "missing-provider", id: "missing-model" });

    await waitFor(() => harness.notices.length > 0);
    assert.deepEqual(harness.applied, [], "nothing may be applied for a model that does not exist");
    assert.match(harness.notices[0] ?? "", /model not found: missing-provider\/missing-model/);
  });
});
