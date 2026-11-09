import test from "node:test";
import assert from "node:assert/strict";
import { startWebServer } from "./main.ts";
import { getPluginDescriptor } from "./plugin-host.ts";
import { clearWebPluginStateForTests } from "./plugin-host.ts";
import { clearSessionsForTests } from "./sessions.ts";

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

    const commandFrame = await tui.readUntil((text) => text.includes("bridge_command"));
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
