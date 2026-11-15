import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

/**
 * The provider details screen must open from the web, in a session the web did
 * not start.
 *
 * The providers page lists one row per configured provider; each row carries
 * its target in the action's `values` (`{ providerId }`). An in-process session
 * (one the web server loaded itself) relays those values straight onto the
 * extension's event bus, so the row works. A bridged session — a pi started in
 * the TUI and attached by the web — travels: action route → bridge action bus →
 * `bridge_command` over the attach stream → `pi.events`. That last hop dropped
 * `values`, so the click posted 200, the manager saw no provider id, and no view
 * was ever published: the details screen never opened, and only bridged
 * sessions were affected.
 *
 * This test drives the whole chain: a real `bridge_command` frame into the real
 * web extension, and the real providers extension on the same event bus.
 */

const SESSION_ID = "bridge-provider-details-session";
const VIEW_EVENT = "web-plugin:view";

const MODELS = {
  providers: {
    openrouter: {
      name: "OpenRouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      models: [{ id: "vendor/model-a", name: "Model A", contextWindow: 128000 }],
    },
  },
};

interface FakeBridge {
  url: string;
  attached: boolean;
  sendCommand(command: Record<string, unknown>): void;
  close(): Promise<void>;
}

async function startFakeBridgeServer(): Promise<FakeBridge> {
  const streams: ServerResponse[] = [];
  const bridge: FakeBridge = {
    url: "",
    attached: false,
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
      bridge.attached = true;
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  bridge.url = `http://127.0.0.1:${address.port}`;
  return bridge;
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Harness {
  /** Every providers view the extension published, in order. */
  views: Array<Record<string, unknown>>;
  /** The providers page is published (the model picker's Provider tab). */
  openProvidersPage(): void;
  stop(): void;
}

/**
 * One mock pi shared by both extensions: a real listener bus, so an action the
 * bridge re-emits reaches the extension that owns it.
 */
async function makeHarness(agentDir: string): Promise<Harness> {
  const views: Array<Record<string, unknown>> = [];
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const emit = (channel: string, data: unknown): void => {
    if (channel === VIEW_EVENT) {
      const payload = data as { pluginId?: string; view?: Record<string, unknown> };
      if (payload.pluginId === "providers" && payload.view !== undefined) views.push(payload.view);
    }
    for (const listener of listeners.get(channel) ?? []) listener(data);
  };
  const mockPi = {
    registerCommand: () => undefined,
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    getCommands: () => [],
    events: {
      emit,
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
  const ctx = {
    cwd: agentDir,
    hasUI: false,
    isIdle: () => true,
    modelRegistry: {
      refresh: async () => undefined,
      getError: () => undefined,
      getAvailable: () => [],
      getAll: () => [],
      getRegisteredProviderIds: () => [],
      getProviderAuthStatus: () => ({ configured: false }),
    },
    sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => undefined },
    ui: { notify: () => undefined, setStatus: () => undefined },
  };

  const { default: providers } = await import("../extensions/providers.ts");
  providers(mockPi as never);
  const { default: webExtension } = await import("../extensions/web.ts");
  webExtension(mockPi as never, { autoReload: false });

  for (const handler of handlers.get("session_start") ?? []) {
    handler({ type: "session_start", reason: "new" }, ctx);
  }

  return {
    views,
    openProvidersPage() {
      // What the model picker's Provider tab does: ask for the announced
      // command by name.
      emit("web-plugin:web-command", { name: "provider", args: "" });
    },
    stop() {
      for (const handler of handlers.get("session_shutdown") ?? []) {
        handler({ type: "session_shutdown" }, ctx);
      }
    },
  };
}

async function withBridgedSession(
  fn: (bridge: FakeBridge, harness: Harness) => Promise<void>,
): Promise<void> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-bridge-provider-"));
  await writeFile(join(agentDir, "models.json"), JSON.stringify(MODELS), "utf8");
  const bridge = await startFakeBridgeServer();
  const testContext = process.env.NODE_TEST_CONTEXT;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.NODE_TEST_CONTEXT;
  process.env.PI_WEB_URL = bridge.url;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let harness: Harness | null = null;
  try {
    harness = await makeHarness(agentDir);
    await fn(bridge, harness);
  } finally {
    harness?.stop();
    if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = testContext;
    delete process.env.PI_WEB_URL;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await bridge.close();
    await rm(agentDir, { recursive: true, force: true });
  }
}

test("clicking a provider row in a bridged session opens its details", async () => {
  await withBridgedSession(async (bridge, harness) => {
    await waitFor(() => bridge.attached, "the bridge to attach");
    harness.openProvidersPage();
    await waitFor(
      () => harness.views.some((view) => view.id === "provider-wizard:home"),
      "the providers page",
    );

    // Exactly the frame the server writes for a row click: the route relays the
    // label as `confirm` and the row's target as `values`.
    bridge.sendCommand({
      type: "action",
      requestId: "req-details-1",
      pluginId: "providers",
      actionId: "provider-manage",
      confirm: "OpenRouter (openrouter)",
      values: { providerId: "openrouter" },
    });

    await waitFor(
      () => harness.views.some((view) => view.id === "provider-manager:detail"),
      "the provider details screen",
    );
    const detail = harness.views.find((view) => view.id === "provider-manager:detail") ?? {};
    assert.equal(detail.title, "OpenRouter", "the details screen names the clicked provider");
    assert.match(
      ((detail.lines as string[] | undefined) ?? []).join("\n"),
      /ID: openrouter/,
      "the details screen shows the clicked provider, not an empty state",
    );
  });
});

test("a form answer typed in a bridged session still reaches the extension", async () => {
  await withBridgedSession(async (bridge, harness) => {
    await waitFor(() => bridge.attached, "the bridge to attach");
    harness.openProvidersPage();
    await waitFor(
      () => harness.views.some((view) => view.id === "provider-wizard:home"),
      "the providers page",
    );

    // The wizard's first step answers with the typed text in `values.value`.
    // The step already offers "List available providers" as its value, so the
    // answer here is the other choice: only a value that actually travelled
    // moves the wizard onto the connection wizard.
    bridge.sendCommand({
      type: "action",
      requestId: "req-details-2",
      pluginId: "providers",
      actionId: "provider-next",
      confirm: "Add a new provider…",
      values: { value: "Add a new provider…" },
    });

    await waitFor(
      () => harness.views.some((view) => view.id === "provider-wizard:id"),
      "the connection wizard's first step",
    );
    const step = harness.views.find((view) => view.id === "provider-wizard:id") ?? {};
    const fields = (step.fields as Array<Record<string, unknown>> | undefined) ?? [];
    assert.equal(fields[0]?.label, "Provider ID", "the answer advanced the wizard to its own step");
  });
});
