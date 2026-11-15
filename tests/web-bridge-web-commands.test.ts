import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

/**
 * Another extension can contribute a web command without editing the bridge.
 *
 * The bridge owns its own built-ins (compact, fork, tree, …) and dispatches
 * them from a private list, so an extension such as the provider editor had no
 * way to run code from the web's command channel.
 *
 * The contract cannot be a shared module: pi evaluates every extension with
 * `moduleCache: false`, so two extensions never share a module instance and a
 * process-global registry reads empty from the other side. It is a bus
 * conversation instead — the contributor announces descriptors, the bridge
 * lists them and asks for one back by name — which these tests pin.
 */

interface FakeBridge {
  url: string;
  /** The `web_commands` event the extension posted, if any. */
  commands(): Array<{ name?: string; description?: string; web?: boolean; managesModels?: boolean; addsModels?: boolean; settingsEntry?: string }>;
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
        addsModels?: boolean;
        settingsEntry?: string;
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
  /** Every dispatch request the bridge asked for, in order. */
  dispatches: Array<{ name: string; args: string }>;
  /** Announce web commands, as a contributing extension would. */
  announce(commands: unknown): void;
  stop(): void;
}

/** Load the real extension and attach a session, with a bus the test can drive. */
async function attachExtension(): Promise<Harness> {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  const dispatches: Array<{ name: string; args: string }> = [];
  const mockPi = {
    registerCommand: () => undefined,
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    },
    getCommands: () => [],
    events: {
      emit: (channel: string, data: unknown) => {
        for (const listener of listeners.get(channel) ?? []) listener(data);
      },
      on: (channel: string, handler: (data: unknown) => void) => {
        const list = listeners.get(channel) ?? [];
        list.push(handler);
        listeners.set(channel, list);
        return () => {
          listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry !== handler));
        };
      },
    },
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

  // Watch the channel the bridge asks a contributor to run its command on.
  listeners.set("web-plugin:web-command", [
    (data: unknown) => {
      const request = data as { name?: string; args?: string };
      if (typeof request?.name === "string") {
        dispatches.push({ name: request.name, args: request.args ?? "" });
      }
    },
  ]);

  return {
    dispatches,
    announce: (commands) => {
      mockPi.events.emit("web-plugin:commands", { commands });
    },
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

test("an announced command is listed for the web with its flags", async () => {
  await withBridgedExtension(async (bridge, harness) => {
    await waitFor(() => bridge.commands().length > 0);

    harness.announce([
      { name: "test-manage-models", description: "Manage the catalogue", managesModels: true, addsModels: true },
    ]);

    await waitFor(() => bridge.commands().some((command) => command.name === "test-manage-models"));
    const listed = bridge.commands().find((command) => command.name === "test-manage-models");
    assert.equal(listed?.web, true, "it dispatches through the web_command channel");
    assert.equal(listed?.managesModels, true, "it gets a page in the shared settings dialog");
    assert.equal(listed?.addsModels, true, "the picker's add entry rides its own flag");
    assert.equal(listed?.description, "Manage the catalogue");
  });
});

test("a managesModels announcement carries its sidebar label to the web", async () => {
  await withBridgedExtension(async (bridge, harness) => {
    await waitFor(() => bridge.commands().length > 0);

    harness.announce([
      {
        name: "test-settings-page",
        description: "Manage the catalogue",
        managesModels: true,
        settingsEntry: "Router",
      },
    ]);

    await waitFor(() => bridge.commands().some((command) => command.name === "test-settings-page"));
    const listed = bridge.commands().find((command) => command.name === "test-settings-page");
    assert.equal(listed?.managesModels, true);
    assert.equal(listed?.settingsEntry, "Router", "the shared dialog's sidebar label");
    assert.equal(listed?.addsModels, undefined, "a page is not the picker's add entry unless it says so");
  });
});

test("a dispatched contributed command is asked for back on the bus", async () => {
  await withBridgedExtension(async (bridge, harness) => {
    await waitFor(() => bridge.commands().length > 0);
    harness.announce([{ name: "test-run", description: "Run it" }]);
    await waitFor(() => bridge.commands().some((command) => command.name === "test-run"));

    bridge.sendCommand({ type: "web_command", name: "test-run", args: "hello" });

    // The bridge cannot call the contributor's handler: it asks, by name.
    await waitFor(() => harness.dispatches.length > 0);
    assert.deepEqual(harness.dispatches, [{ name: "test-run", args: "hello" }]);
  });
});

test("a web command nobody announced is not asked for", async () => {
  await withBridgedExtension(async (bridge, harness) => {
    await waitFor(() => bridge.commands().length > 0);

    bridge.sendCommand({ type: "web_command", name: "test-missing" });

    // Give the frame time to arrive; nothing must be dispatched or thrown.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(harness.dispatches, []);
  });
});

test("a malformed announcement is ignored instead of breaking the list", async () => {
  await withBridgedExtension(async (bridge, harness) => {
    await waitFor(() => bridge.commands().length > 0);

    harness.announce([{ name: "", description: "no name" }, { description: "no name at all" }, 42]);

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(
      bridge.commands().filter((command) => command.description === "no name"),
      [],
      "an entry without a name never reaches the picker",
    );
  });
});
