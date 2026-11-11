import test from "node:test";
import assert from "node:assert/strict";
import { startWebServer } from "./main.ts";
import {
  clearSessionsForTests,
  registerSession,
  subscribeSessionDirectory,
  unregisterSession,
  type SessionCore,
  type SessionDirectoryEvent,
  type SessionStateLite,
} from "./sessions.ts";

/** A live session core whose lifecycle events the test drives directly. */
function directoryCore(id: string, initialRunning = false): {
  core: SessionCore;
  emit: (event: unknown) => void;
} {
  let listener: ((event: unknown) => void) | null = null;
  const state: SessionStateLite = {
    sessionId: id,
    sessionFile: "",
    isStreaming: initialRunning,
    isBashRunning: false,
    isCompacting: false,
    model: undefined,
    contextUsage: null,
    thinkingLevel: "off",
  };
  const core: SessionCore = {
    sessionId: id,
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    prompt: async () => {},
    abort: async () => {},
    isStreaming: () => state.isStreaming,
    getState: () => state,
  };
  return {
    core,
    emit: (event: unknown) => {
      // Keep the snapshot's running bit consistent with the simulated turn.
      const type = (event as { type?: unknown } | null)?.type;
      if (type === "agent_start") state.isStreaming = true;
      else if (type === "agent_settled" || type === "session_shutdown") state.isStreaming = false;
      listener?.(event);
    },
  };
}

test.afterEach(() => {
  clearSessionsForTests();
});

test("directory emits added/running/removed transitions and dedups repeated states", () => {
  const events: SessionDirectoryEvent[] = [];
  const unsubscribe = subscribeSessionDirectory((event) => {
    events.push(event);
  });
  try {
    const { core, emit } = directoryCore("dir-1");
    registerSession(core, "/tmp/project");

    // Membership announced on register, carrying the initial running bit.
    const added = events.filter((e) => e.type === "session_added");
    assert.equal(added.length, 1);
    if (added[0]?.type === "session_added") {
      assert.equal(added[0].session.id, "dir-1");
      assert.equal(added[0].session.live, true);
      assert.equal(added[0].session.running, false);
    }

    // Running flips once per state change; repeated agent_start is suppressed.
    emit({ type: "agent_start" });
    emit({ type: "agent_start" });
    assert.equal(
      events.filter((e) => e.type === "session_running" && e.running).length,
      1,
      "one running:true transition despite a repeated agent_start",
    );

    emit({ type: "agent_settled" });
    emit({ type: "agent_settled" });
    assert.equal(
      events.filter((e) => e.type === "session_running" && !e.running).length,
      1,
      "one running:false transition despite a repeated agent_settled",
    );

    // Removal on unregister.
    unregisterSession("dir-1");
    assert.ok(
      events.some((e) => e.type === "session_removed" && e.id === "dir-1"),
      "session_removed emitted on unregister",
    );
  } finally {
    unsubscribe();
  }
});

test("re-registering a session (bridge takeover) re-announces membership", () => {
  const events: SessionDirectoryEvent[] = [];
  const unsubscribe = subscribeSessionDirectory((event) => {
    events.push(event);
  });
  try {
    const first = directoryCore("dir-2");
    registerSession(first.core, "/tmp/project");
    const second = directoryCore("dir-2", true);
    registerSession(second.core, "/tmp/project");

    const added = events.filter((e) => e.type === "session_added");
    assert.equal(added.length, 2, "the replace path re-announces the session");
    if (added[1]?.type === "session_added") {
      assert.equal(added[1].session.running, true, "the new owner's running state is carried");
    }
  } finally {
    unsubscribe();
  }
});

interface ReaderLike {
  read(): Promise<{ done?: boolean; value?: Uint8Array }>;
}

function createFrameReader(reader: ReaderLike) {
  const decoder = new TextDecoder();
  let buffer = "";
  return async function readUntil(predicate: (text: string) => boolean, timeoutMs = 5000): Promise<string> {
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
    throw new Error(`timed out waiting for SSE frame; received: ${JSON.stringify(buffer.slice(0, 500))}`);
  };
}

test("sessions stream sends a snapshot then pushes running transitions", async () => {
  const { core, emit } = directoryCore("dir-stream");
  registerSession(core, "/tmp/project");
  const handle = await startWebServer({ port: 0, host: "127.0.0.1" });
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/events`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.ok(res.body !== null, "stream body must be readable");
    const reader = res.body.getReader();
    const readUntil = createFrameReader(reader);

    // Snapshot carries the live registry (the directory core) at connect.
    const snapshot = await readUntil((text) => text.includes("\"type\":\"sessions_snapshot\""));
    assert.match(snapshot, /"id":"dir-stream"/);
    assert.match(snapshot, /"running":false/);

    // A simulated turn start is pushed as a transition, not discovered by a poll.
    emit({ type: "agent_start" });
    const running = await readUntil(
      (text) => text.includes("\"type\":\"session_running\"") && text.includes("\"running\":true"),
    );
    assert.match(running, /"id":"dir-stream"/);

    await reader.cancel();
  } finally {
    await handle.close();
  }
});