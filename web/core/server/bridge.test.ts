import test from "node:test";
import assert from "node:assert/strict";
import { startWebServer } from "./main.ts";
import { getBridge, healBridgeRegistration } from "./bridge.ts";
import { getPluginDescriptor } from "./plugin-host.ts";
import { clearWebPluginStateForTests } from "./plugin-host.ts";
import { clearSessionsForTests, getSession, registerSession } from "./sessions.ts";
import { piBuiltinCommands } from "../../../lib/web-pi-apis/index.ts";
import { annotateBuiltinCommands } from "../shared/commands.ts";

test.afterEach(() => {
  clearSessionsForTests();
  clearWebPluginStateForTests();
});

interface ReaderLike {
  read(): Promise<{ done?: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

/** An SSE frame reader with a persistent buffer (see event-stream tests). */
function createFrameReader(reader: ReaderLike) {
  const decoder = new TextDecoder();
  let buffer = "";
  return async function readUntil(
    predicate: (text: string) => boolean,
    timeoutMs = 5000,
  ): Promise<string> {
    if (predicate(buffer)) return buffer;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);
      if (chunk === null) break;
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (predicate(buffer)) return buffer;
    }
    throw new Error(
      `timed out waiting for SSE frame; received so far: ${JSON.stringify(buffer.slice(0, 400))}`,
    );
  };
}

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const handle = await startWebServer({ port: 0, host: "127.0.0.1" });
  try {
    await fn(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

/** Attach a fake TUI bridge and read its command stream. */
async function attachFakeTui(
  baseUrl: string,
  sessionId: string,
  cwd = "/tmp/bridge-proj",
): Promise<{ readUntil: (predicate: (text: string) => boolean, timeoutMs?: number) => Promise<string>; detach: () => void; reader: ReaderLike }> {
  const controller = new AbortController();
  const res = await fetch(
    `${baseUrl}/api/bridge/${encodeURIComponent(sessionId)}/attach?cwd=${encodeURIComponent(cwd)}`,
    { signal: controller.signal, headers: { accept: "text/event-stream" } },
  );
  assert.equal(res.status, 200);
  assert.ok(res.body !== null);
  const reader = res.body.getReader();
  const readUntil = createFrameReader(reader);
  const attached = await readUntil((text) => text.includes("bridge_attached"));
  assert.match(attached, new RegExp(sessionId));
  return {
    readUntil,
    reader,
    detach: () => {
      controller.abort();
    },
  };
}

async function postEvents(baseUrl: string, sessionId: string, events: unknown[]): Promise<void> {
  const res = await fetch(`${baseUrl}/api/bridge/${encodeURIComponent(sessionId)}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
  });
  assert.equal(res.status, 200);
}

test("web_commands events surface through /api/agent/:id/commands", async () => {
  await withServer(async (baseUrl) => {
    await attachFakeTui(baseUrl, "bridge-commands");
    await postEvents(baseUrl, "bridge-commands", [
      {
        type: "web_commands",
        commands: [
          { name: "web", description: "Manage pi-web UI server" },
          { name: "todo" },
          { name: "", description: "invalid: no name" },
          "not-an-object",
        ],
      },
    ]);

    const res = await fetch(`${baseUrl}/api/agent/bridge-commands/commands`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      commands?: Array<{ name: string; description?: string }>;
    };
    // pi's runtime builtins lead the list (annotated with the web's
    // presentation flags), then the posted live commands.
    const expected = [
      ...annotateBuiltinCommands(await piBuiltinCommands()),
      { name: "web", description: "Manage pi-web UI server" },
      { name: "todo" },
    ];
    assert.deepEqual(body.commands, expected);

    // A later posting replaces the live list (extension reload); the
    // builtins stay — they come from pi, not the posting.
    await postEvents(baseUrl, "bridge-commands", [
      { type: "web_commands", commands: [{ name: "modes" }] },
    ]);
    const updated = (await (await fetch(`${baseUrl}/api/agent/bridge-commands/commands`)).json()) as {
      commands?: Array<{ name: string }>;
    };
    assert.deepEqual(updated.commands, [...annotateBuiltinCommands(await piBuiltinCommands()), { name: "modes" }]);
  });
});

test("commands route is 404 for sessions that are not live", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/agent/unknown-session/commands`);
    assert.equal(res.status, 404);
  });
});

test("an attached bridge is the live session, and detaching drops it", async () => {
  await withServer(async (baseUrl) => {
    const tui = await attachFakeTui(baseUrl, "bridge-a");

    const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
      sessions?: Array<{ id: string; cwd: string; live: boolean }>;
    };
    const entry = list.sessions?.find((session) => session.id === "bridge-a");
    assert.ok(entry, "the bridged session must be listed");
    assert.equal(entry.live, true);
    assert.equal(entry.cwd, "/tmp/bridge-proj");

    tui.detach();
    // The request close detaches the bridge; the registry drops the session.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
      sessions?: Array<{ id: string }>;
    };
    assert.equal(after.sessions?.some((session) => session.id === "bridge-a"), false);
  });
});

test("events posted by the TUI reach the browser stream and the plugin state", async () => {
  await withServer(async (baseUrl) => {
    const tui = await attachFakeTui(baseUrl, "bridge-b");

    // The browser subscribes to the bridged session.
    const stream = await fetch(`${baseUrl}/api/agent/bridge-b/events`);
    assert.ok(stream.body !== null);
    const streamReader = stream.body.getReader();
    const streamRead = createFrameReader(streamReader);
    await streamRead((text) => text.includes("\"type\":\"connected\""));
    await streamRead((text) => text.includes("\"type\":\"plugin_state\""));

    // The TUI streams a turn.
    await postEvents(baseUrl, "bridge-b", [
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi " } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "tui" } },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "hi tui" }] },
      },
      { type: "agent_settled" },
    ]);

    const frames = await streamRead((text) => text.includes("hi tui"));
    assert.match(frames, /"delta":"hi "/);
    assert.match(frames, /"agent_start"/);
    // Lifecycle recording flips the running flag in the plugin_state frame.
    assert.match(frames, /"running":false/);

    // Plugin views from the TUI publishers land in the store.
    await postEvents(baseUrl, "bridge-b", [
      { type: "web_plugin_view", payload: { pluginId: "todo", view: { type: "status", tone: "accent", text: "from tui" } } },
    ]);
    const viewFrame = await streamRead(
      (text) => text.includes("\"type\":\"plugin_state\"") && text.includes("from tui"),
    );
    assert.match(viewFrame, /"todo"/);

    tui.detach();
    await streamReader.cancel().catch(() => undefined);
  });
});

test("a browser prompt becomes a bridge command; state posts surface in the state read", async () => {
  await withServer(async (baseUrl) => {
    const tui = await attachFakeTui(baseUrl, "bridge-c", "/tmp/bridge-c");

    const prompt = await fetch(`${baseUrl}/api/agent/bridge-c`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prompt", message: "hello from the web" }),
    });
    assert.equal(prompt.status, 200);
    const body = (await prompt.json()) as { success?: boolean; data?: { accepted?: boolean } };
    assert.equal(body.data?.accepted, true);

    const commandFrame = await tui.readUntil((text) => text.includes("\"type\":\"prompt\""));
    assert.match(commandFrame, /"type":"prompt"/);
    assert.match(commandFrame, /"message":"hello from the web"/);

    // The TUI reports its state; the web's state read serves it.
    const stateRes = await fetch(`${baseUrl}/api/bridge/bridge-c/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: {
          isStreaming: true,
          model: { provider: "anthropic", id: "claude-sonnet" },
          thinkingLevel: "high",
        },
      }),
    });
    assert.equal(stateRes.status, 200);

    const state = await (await fetch(`${baseUrl}/api/agent/bridge-c`)).json() as {
      running?: boolean;
      state?: { isStreaming?: boolean; model?: { id: string }; thinkingLevel?: string };
    };
    assert.equal(state.running, true);
    assert.equal(state.state?.isStreaming, true);
    assert.equal(state.state?.model?.id, "claude-sonnet");
    assert.equal(state.state?.thinkingLevel, "high");

    tui.detach();
  });
});

test("plugin actions relay through the bridge to the TUI", async () => {
  await withServer(async (baseUrl) => {
    const tui = await attachFakeTui(baseUrl, "bridge-d", "/tmp/bridge-d");
    const modes = getPluginDescriptor("modes");
    const instant = modes?.actions?.find(
      (action) => action.confirm === undefined && action.keybinding !== undefined,
    );
    assert.ok(instant, "modes must declare an instant keybound action");

    const res = await fetch(`${baseUrl}/api/plugins/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "bridge-d", pluginId: "modes", actionId: instant.id }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean; relayed?: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.relayed, true, "the bridge bus must relay the action");

    const commandFrame = await tui.readUntil((text) => text.includes("\"type\":\"action\""));
    assert.match(commandFrame, new RegExp(`"pluginId":"modes"`));
    assert.match(commandFrame, new RegExp(`"actionId":"${instant.id}"`));

    tui.detach();
  });
});

test("a browser stream attaching mid-turn replays the partial the TUI posted", async () => {
  await withServer(async (baseUrl) => {
    const tui = await attachFakeTui(baseUrl, "bridge-f", "/tmp/bridge-f");
    // The TUI's turn is already in flight — its partial crossed the bridge
    // BEFORE the browser stream opened (a reload-mid-stream).
    await postEvents(baseUrl, "bridge-f", [
      { type: "message_start", message: { role: "assistant", content: [] } },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "ignored",
          partial: { role: "assistant", content: [{ type: "text", text: "the in-flight reply" }] },
        },
      },
    ]);

    const stream = await fetch(`${baseUrl}/api/agent/bridge-f/events`);
    assert.ok(stream.body !== null);
    const streamRead = createFrameReader(stream.body.getReader());
    const replayed = await streamRead((text) => text.includes("the in-flight reply"));
    // The replay is a synthetic message_start carrying the cumulative
    // partial, ordered after connected and before any live delta.
    assert.match(replayed, /"type":"message_start"/);
    const connectedAt = replayed.indexOf('"type":"connected"');
    const replayAt = replayed.indexOf("the in-flight reply");
    assert.ok(connectedAt !== -1 && replayAt > connectedAt, "the replay follows connected");

    tui.detach();
  });
});

test("a detached bridge's grace window blocks the in-process resume (no split-brain)", async () => {
  await withServer(async (baseUrl) => {
    const tui = await attachFakeTui(baseUrl, "bridge-grace", "/tmp/bridge-grace");
    // The bridge detaches (a server drop / stream break); the extension's
    // self-heal is about to re-attach.
    tui.detach();

    // A request racing the re-attach must NOT resume the session
    // in-process — it waits out the grace window and resolves to the
    // re-attached bridge instead.
    const statePromise = fetch(`${baseUrl}/api/agent/bridge-grace`).then((res) => res.json());
    await new Promise((resolve) => setTimeout(resolve, 300));
    // While the request waits, the bridge re-attaches.
    const reattached = await attachFakeTui(baseUrl, "bridge-grace", "/tmp/bridge-grace");
    const body = (await statePromise) as { state?: { isStreaming?: boolean } };
    assert.ok(body.state !== undefined, "the request resolved to the re-attached bridge, not an error");

    reattached.detach();
  });
});

test("the drift heal takes the session back from a slipped-in in-process copy", async () => {
  await withServer(async (baseUrl) => {
    const tui = await attachFakeTui(baseUrl, "bridge-heal", "/tmp/bridge-heal");
    // Simulate the corruption the heal exists for: the registry entry
    // flipped to an in-process-style core while the bridge stayed attached.
    let disposed = false;
    registerSession(
      {
        sessionId: "bridge-heal",
        subscribe: () => () => {},
        prompt: async () => {},
        abort: async () => {},
        isStreaming: () => false,
        getState: () => ({
          sessionId: "bridge-heal",
          sessionFile: "",
          isStreaming: false,
          isBashRunning: false,
          isCompacting: false,
          model: undefined,
          contextUsage: null,
          thinkingLevel: "off",
        }),
        dispose: () => {
          disposed = true;
        },
      },
      "/tmp/bridge-heal",
    );

    // The heal: the bridge re-registers and the displaced copy is disposed.
    healBridgeRegistration(getBridge("bridge-heal")!);

    const core = getSession("bridge-heal")?.core;
    assert.ok(core !== undefined);
    // The registry answers through the bridge again: commands posted by the
    // TUI surface through getCommands.
    await postEvents(baseUrl, "bridge-heal", [
      { type: "web_commands", commands: [{ name: "healed", description: "via the bridge" }] },
    ]);
    assert.deepEqual(
      (getSession("bridge-heal")?.core.getCommands?.() ?? []).find((c) => c.name === "healed"),
      { name: "healed", description: "via the bridge" },
      "the bridge core owns the session again",
    );
    assert.equal(disposed, true, "the displaced in-process copy was disposed");
    tui.detach();
  });
});

test("detach ends the browser streams with session_shutdown", async () => {
  await withServer(async (baseUrl) => {
    await attachFakeTui(baseUrl, "bridge-e", "/tmp/bridge-e");
    const stream = await fetch(`${baseUrl}/api/agent/bridge-e/events`);
    assert.ok(stream.body !== null);
    const streamReader = stream.body.getReader();
    const streamRead = createFrameReader(streamReader);
    await streamRead((text) => text.includes("\"type\":\"connected\""));

    const detach = await fetch(`${baseUrl}/api/bridge/bridge-e/detach`, { method: "POST" });
    assert.equal(detach.status, 200);

    // The stream ends — the same semantics an in-process session's shutdown
    // has; the browser's EventSource reconnects and re-resolves.
    const finished = await streamReader.read();
    assert.equal(finished.done, true, "the browser stream ends after the bridge detaches");
  });
});
