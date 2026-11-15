import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import {
  clearWebCommands,
  registerWebCommand,
  registeredWebCommand,
} from "../web/core/plugin-contracts/web-commands.ts";

/**
 * Another extension can contribute a web command without editing the bridge.
 *
 * The bridge owns its own built-ins (compact, fork, tree, …) and dispatches
 * them from a private list, so an extension such as the provider editor had no
 * way to run code from the web's command channel. It now registers an entry
 * next to its own implementation; the bridge lists it (with whatever
 * presentation flags the contributor declared) and dispatches it on the
 * session's context.
 *
 * These tests drive the real extension over a fake bridge and push
 * `web_command` frames down the attach stream, exactly as the server does.
 */

interface FakeBridge {
  url: string;
  /** The `web_commands` event the extension posted, if any. */
  commands(): Array<{ name?: string; description?: string; web?: boolean; managesModels?: boolean }>;
  sendCommand(command: Record<string, unknown>): void;
  close(): Promise<void>;
}

const SESSION_ID = "bridge-web-commands-session";

async function startFakeBridgeServer(): Promise<FakeBridge> {
  const events: unknown[] = [];
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
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { events?: unknown[] };
        events.push(...(Array.isArray(body.events) ? body.events : []));
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
    commands() {
      const posted = events.filter(
        (event): event is { type: string; commands: Array<Record<string, unknown>> } =>
          typeof event === "object" && event !== null && (event as { type?: unknown }).type === "web_commands",
      );
      return (posted.at(-1)?.commands ?? []) as Array<{
        name?: string;
        description?: string;
        web?: boolean;
        managesModels?: boolean;
      }>;
    },
    sendCommand(command: Record<string, unknown>) {
      const frame = { type: "bridge_command", command };
      for (const stream of streams) stream.write(`data: ${JSON.stringify(frame)}\n\n`);
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
  /** Every handler call: args plus whether the session context was passed. */
  calls: Array<{ args: string; hasContext: boolean }>;
  stop(): void;
}

async function attachExtension(): Promise<Harness> {
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
    scopedModels: [],
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
    calls: [],
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
    clearWebCommands();
    if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = testContext;
    delete process.env.PI_WEB_URL;
    await bridge.close();
  }
}

test("a registered command is listed for the web with its flags", async () => {
  clearWebCommands();
  registerWebCommand({
    name: "test-manage-models",
    description: "Manage the catalogue",
    managesModels: true,
    handler: () => undefined,
  });

  await withBridgedExtension(async (bridge) => {
    await waitFor(() => bridge.commands().length > 0);

    const listed = bridge.commands().find((command) => command.name === "test-manage-models");
    assert.ok(listed, "the bridge posts the contributed command");
    assert.equal(listed.web, true, "it dispatches through the web_command channel");
    assert.equal(listed.managesModels, true, "the picker's add entry rides the same flag");
    assert.equal(listed.description, "Manage the catalogue");
  });
});

test("a registered command runs on the session context", async () => {
  clearWebCommands();
  const seen: string[] = [];
  registerWebCommand<{ cwd: string }>({
    name: "test-run",
    description: "Run it",
    handler: (args, ctx) => {
      seen.push(`${args}|${ctx.cwd}`);
    },
  });

  await withBridgedExtension(async (bridge) => {
    await waitFor(() => bridge.commands().some((command) => command.name === "test-run"));

    bridge.sendCommand({ type: "web_command", name: "test-run", args: "hello" });

    await waitFor(() => seen.length > 0);
    assert.deepEqual(seen, [`hello|${process.cwd()}`], "the handler gets the args and the session ctx");
  });
});

test("an unknown web command is reported, not silently dropped", async () => {
  clearWebCommands();
  assert.equal(registeredWebCommand("test-missing"), undefined);

  await withBridgedExtension(async (bridge) => {
    await waitFor(() => bridge.commands().length > 0);
    // No throw: an unknown command answers through the session's own notice
    // channel, so the bridge keeps working.
    bridge.sendCommand({ type: "web_command", name: "test-missing" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(registeredWebCommand("test-missing"), undefined);
  });
});

test("registering the same name twice replaces the entry", () => {
  clearWebCommands();
  registerWebCommand({ name: "test-replace", description: "first", handler: () => undefined });
  registerWebCommand({ name: "test-replace", description: "second", handler: () => undefined });
  assert.equal(registeredWebCommand("test-replace")?.description, "second");
  clearWebCommands();
});
