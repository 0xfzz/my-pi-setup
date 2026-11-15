import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

/**
 * A TUI-owned session showed a one-row model picker in the web, and an empty
 * command palette.
 *
 * The extension posted `web_models` and `web_commands` *before* opening the
 * attach stream. The server registers a bridge only when the attach arrives,
 * so `POST /api/bridge/:id/events` answered 404 and both events were dropped
 * (the poster's flush is fire-and-forget, so the 404 is swallowed). The
 * server's cached list then stayed null for the life of the bridge, and
 * `bridgeSessionCore.getModels()` falls back to a one-row picker built from
 * the current model — exactly what the browser showed. `/api/agent/:id/models`
 * served the same one row, and the composer's palette read an empty command
 * list. The in-process path (a session the server resumed itself) never had
 * the bug: it reads the catalogue straight from its own AgentSession.
 *
 * These tests drive the real extension against a fake bridge server that keeps
 * the real contract: the bridge exists only once the attach response is
 * written, and a post for a bridge-less session is refused.
 */

interface FakeBridge {
  url: string;
  /** Every event the server accepted, in arrival order. */
  events: unknown[];
  /** Event posts refused because no bridge existed yet. */
  rejectedPosts: number;
  /** End the open attach streams, as a dropped connection does. */
  dropStreams(): void;
  close(): Promise<void>;
}

const SESSION_ID = "bridge-attach-lists-session";

/**
 * How long the fake server takes to write the attach response. The real
 * server is never instantaneous, and the extension's 25 ms event batch would
 * otherwise make the pre-attach post a socket race instead of a defect.
 */
const ATTACH_HOLD_MS = 50;

const CATALOGUE = [
  { provider: "anthropic", id: "claude-x" },
  { provider: "openai-codex", id: "gpt-6" },
  { provider: "router", id: "glm-5" },
];

async function startFakeBridgeServer(): Promise<FakeBridge> {
  let attached = false;
  const events: unknown[] = [];
  const streams: ServerResponse[] = [];
  let rejectedPosts = 0;
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
      setTimeout(() => {
        attached = true;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(":\n\n");
        streams.push(res);
      }, ATTACH_HOLD_MS);
      return;
    }
    if (path === `/api/bridge/${SESSION_ID}/events`) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          events?: unknown[];
          event?: unknown;
        };
        if (!attached) {
          // Exactly what web/core/server/routes.ts answers for a session with
          // no bridge — the drop these tests guard against.
          rejectedPosts++;
          res.writeHead(404, { "Content-Type": "application/json", Connection: "close" });
          res.end(JSON.stringify({ error: "Bridge not attached" }));
          return;
        }
        events.push(...(Array.isArray(body.events) ? body.events : []));
        if (body.event !== undefined) events.push(body.event);
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
    events,
    get rejectedPosts() {
      return rejectedPosts;
    },
    dropStreams() {
      attached = false;
      for (const stream of streams.splice(0)) stream.end();
    },
    async close() {
      for (const stream of streams.splice(0)) stream.end();
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
  stop(): void;
}

/** Load the real extension over a session with no model scope. */
async function attachExtension(): Promise<Harness> {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const mockPi = {
    registerCommand: () => undefined,
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    },
    getCommands: () => [{ name: "todo", description: "todo tools" }],
    events: { emit: () => undefined, on: () => () => undefined },
    setModel: async () => true,
    setThinkingLevel: () => undefined,
  };
  const models = CATALOGUE.map((ref) => ({ ...ref }));
  const mockCtx = {
    cwd: process.cwd(),
    hasUI: false,
    model: models[0],
    scopedModels: [],
    thinkingLevel: "off",
    isIdle: () => true,
    getContextUsage: () => null,
    modelRegistry: {
      getAvailable: () => models,
      find: (provider: string, id: string) =>
        models.find((candidate) => candidate.provider === provider && candidate.id === id),
    },
    sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => undefined },
    ui: { notify: () => undefined, setStatus: () => undefined },
  };

  const { default: webExtension } = await import("../extensions/web.ts");
  webExtension(mockPi as never, { autoReload: false });
  const onSessionStart = handlers.get("session_start");
  assert.ok(onSessionStart !== undefined, "the extension registers session_start");
  onSessionStart({ type: "session_start", reason: "new" }, mockCtx);

  return {
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

/** The last `web_models` event the server accepted, if any. */
function modelsEventOf(bridge: FakeBridge): { models?: unknown; all?: unknown; current?: unknown } | undefined {
  const posted = bridge.events.filter(
    (event): event is { type: string; models?: unknown; all?: unknown; current?: unknown } =>
      typeof event === "object" && event !== null && (event as { type?: unknown }).type === "web_models",
  );
  return posted.at(-1);
}

test("the picker's model list lands after the attach stream opens", async () => {
  await withBridgedExtension(async (bridge) => {
    await waitFor(() => modelsEventOf(bridge) !== undefined);

    const posted = modelsEventOf(bridge);
    assert.deepEqual(
      posted?.models,
      CATALOGUE,
      "the picker offers every available model, not just the current one",
    );
    assert.deepEqual(posted?.all, CATALOGUE, "the All tab carries the same catalogue");
    assert.deepEqual(posted?.current, CATALOGUE[0], "the current model is marked");
    assert.equal(
      bridge.rejectedPosts,
      0,
      "no event post may be sent before the bridge exists",
    );
  });
});

test("the command list lands after the attach stream opens", async () => {
  await withBridgedExtension(async (bridge) => {
    await waitFor(() =>
      bridge.events.some((event) =>
        typeof event === "object" && event !== null && (event as { type?: unknown }).type === "web_commands"
      )
    );

    const posted = bridge.events.find(
      (event): event is { type: string; commands?: Array<{ name?: string }> } =>
        typeof event === "object" && event !== null && (event as { type?: unknown }).type === "web_commands",
    );
    assert.ok(
      posted?.commands?.some((command) => command.name === "todo"),
      "the composer's palette gets the session's dispatchable commands",
    );
    assert.equal(bridge.rejectedPosts, 0);
  });
});

test("a re-attach re-posts the list, because a fresh bridge has none", async () => {
  await withBridgedExtension(async (bridge) => {
    await waitFor(() => modelsEventOf(bridge) !== undefined);
    const afterFirstAttach = bridge.events.filter(
      (event) => typeof event === "object" && (event as { type?: unknown }).type === "web_models",
    ).length;

    // A dropped connection closes the server's bridge; the extension's retry
    // opens a new one, which starts with an empty model list.
    bridge.dropStreams();

    await waitFor(() =>
      bridge.events.filter(
        (event) => typeof event === "object" && (event as { type?: unknown }).type === "web_models",
      ).length > afterFirstAttach
    );
    assert.deepEqual(modelsEventOf(bridge)?.models, CATALOGUE);
    assert.equal(bridge.rejectedPosts, 0);
  });
});
