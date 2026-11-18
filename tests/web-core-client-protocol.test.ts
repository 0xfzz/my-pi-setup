// Regression suite for the browser's single protocol seam. The client used to
// convert a named handshake failure into a generic transport error, parse raw
// legacy frames itself, and leave components posting to pi routes directly.
// These tests inject fetch and EventSource so no server or DOM is needed.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { directoryProtocolClient, ProtocolClient } from "../web/core/client/protocol-client.ts";
import { mergeHistoryEntries, type HistoryEntryLike } from "../web/core/client/history-pages.ts";

type Reply = { ok: true; value: { payload: unknown } } | { ok: false; error: Record<string, unknown> };

interface FetchCall {
  url: string;
  body: { name?: string; payload?: unknown; sessionId?: string; source?: { id?: string } };
}

function scriptedFetch(reply: (call: FetchCall, index: number) => Reply | Error, calls: FetchCall[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? "{}")) as FetchCall["body"];
    const call: FetchCall = { url, body };
    calls.push(call);
    const answer = reply(call, calls.length - 1);
    if (answer instanceof Error) throw answer;
    return {
      ok: true,
      status: 200,
      json: async () => answer,
    } as Response;
  }) as typeof fetch;
}

const helloReply: Reply = {
  ok: true,
  value: { payload: { version: 1, capabilities: [], bindings: ["http-sse"], sessionId: "s1", cursor: "0" } },
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

function envelope(name: string, payload: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: "pi-web-bridge",
    version: 1,
    kind: "event",
    name,
    messageId: "pi-1",
    sessionId: "s1",
    source: { type: "core", id: "pi" },
    timestamp: 0,
    payload,
    ...overrides,
  };
}

test("a named VERSION_MISMATCH from the handshake survives as VERSION_MISMATCH", async () => {
  const calls: FetchCall[] = [];
  const fetcher = scriptedFetch((call) => {
    if (call.body.name === "bridge.hello") {
      return { ok: false, error: { code: "VERSION_MISMATCH", message: "peer speaks protocol v9", retryable: false } };
    }
    return { ok: true, value: { payload: {} } };
  }, calls);
  const client = new ProtocolClient({ sessionId: "s1", fetch: fetcher });

  const outcome = await client.query("ui.snapshot");

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error.code, "VERSION_MISMATCH");
  assert.equal(calls.length, 1, "no command is sent after the handshake is refused");
});

test("a mismatched hello ack is reported as VERSION_MISMATCH, not UNSUPPORTED_BINDING", async () => {
  const calls: FetchCall[] = [];
  const fetcher = scriptedFetch((call) => {
    if (call.body.name === "bridge.hello") {
      return { ok: true, value: { payload: { version: 99, capabilities: [] } } };
    }
    return { ok: true, value: { payload: {} } };
  }, calls);
  const client = new ProtocolClient({ sessionId: "s1", fetch: fetcher });

  const outcome = await client.invoke("ui.snapshot", {});

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error.code, "VERSION_MISMATCH");
});

test("a named error in a protocol reply is preserved", async () => {
  const calls: FetchCall[] = [];
  const fetcher = scriptedFetch((call) => {
    if (call.body.name === "bridge.hello") return helloReply;
    return {
      ok: true,
      value: { payload: null, error: { code: "CAPABILITY_DENIED", message: "session.read was denied", retryable: false } },
    };
  }, calls);
  const client = new ProtocolClient({ sessionId: "s1", fetch: fetcher });

  const outcome = await client.query("session.history", { limit: 50 });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error.code, "CAPABILITY_DENIED");
});

test("a migrated session query goes only through the protocol binding", async () => {
  const calls: FetchCall[] = [];
  const fetcher = scriptedFetch((call) => {
    if (call.body.name === "bridge.hello") return helloReply;
    return { ok: true, value: { payload: { entries: [] } } };
  }, calls);
  const client = new ProtocolClient({ sessionId: "s1", fetch: fetcher });

  await client.query("session.history", { limit: 50, direction: "newer" });

  assert.deepEqual(calls.map((call) => call.url), ["/api/agent/s1/protocol", "/api/agent/s1/protocol"]);
  assert.deepEqual(calls.map((call) => call.body.name), ["bridge.hello", "session.history"]);
});

test("transport failures keep the UNSUPPORTED_BINDING code", async () => {
  const calls: FetchCall[] = [];
  const fetcher = scriptedFetch(() => new Error("socket gone"), calls);
  const client = new ProtocolClient({ sessionId: "s1", fetch: fetcher });

  const outcome = await client.query("ui.snapshot");

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, "UNSUPPORTED_BINDING");
    assert.match(outcome.error.message, /socket gone/);
  }
});

test("a malformed hello is refused before any request is issued", async () => {
  const calls: FetchCall[] = [];
  const fetcher = scriptedFetch(() => helloReply, calls);
  const client = new ProtocolClient({ sessionId: "s1", clientId: "", fetch: fetcher });

  const outcome = await client.query("ui.snapshot");

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error.code, "VALIDATION_FAILED");
  assert.equal(calls.length, 0, "an invalid hello never reaches the wire");
});

test("subscribe delivers protocol envelopes with their sequence and cursor", () => {
  FakeEventSource.instances = [];
  const client = new ProtocolClient({
    sessionId: "s1",
    fetch: scriptedFetch(() => helloReply, []),
    eventSource: FakeEventSource as unknown as typeof EventSource,
  });
  const seen: Array<{ sequence?: number; cursor?: string; payload: unknown }> = [];
  const unsubscribe = client.subscribe("ui.notify", (received) => {
    seen.push({ sequence: received.sequence, cursor: received.cursor, payload: received.payload });
  });
  const source = FakeEventSource.instances.at(-1);
  assert.ok(source !== undefined);

  source.emit({ type: "notify", message: "legacy frames are not protocol frames" });
  source.emit(envelope("ui.notify", { message: "hello" }, { sequence: 7, cursor: "c7" }));

  assert.deepEqual(seen, [{ sequence: 7, cursor: "c7", payload: { message: "hello" } }]);
  unsubscribe();
  assert.equal(source.closed, true);
});

test("session and directory streams deliver their named envelopes with cursors", () => {
  FakeEventSource.instances = [];
  const client = new ProtocolClient({
    sessionId: "s1",
    fetch: scriptedFetch(() => helloReply, []),
    eventSource: FakeEventSource as unknown as typeof EventSource,
  });
  const sessionEvents: unknown[] = [];
  const directoryEvents: unknown[] = [];
  const leaveSession = client.subscribe("session.events", (frame) => {
    sessionEvents.push([frame.sequence, frame.cursor, frame.payload]);
  });
  const leaveDirectory = client.subscribe("session.directory.events", (frame) => {
    directoryEvents.push([frame.sequence, frame.cursor, frame.payload]);
  });

  assert.equal(FakeEventSource.instances.length, 2);
  assert.match(FakeEventSource.instances[0].url, /\/api\/agent\/s1\/events$/);
  assert.match(FakeEventSource.instances[1].url, /\/api\/sessions\/events$/);
  FakeEventSource.instances[0].emit(envelope("session.events", { type: "agent_start" }, { sequence: 3, cursor: "p3" }));
  FakeEventSource.instances[1].emit(envelope("session.directory.events", { type: "session_added" }, { sequence: 5, cursor: "p5" }));

  assert.deepEqual(sessionEvents, [[3, "p3", { type: "agent_start" }]]);
  assert.deepEqual(directoryEvents, [[5, "p5", { type: "session_added" }]]);
  leaveSession();
  leaveDirectory();
});

test("multiple subscribers share one EventSource until the last one leaves", () => {
  FakeEventSource.instances = [];
  const client = new ProtocolClient({
    sessionId: "s1",
    fetch: scriptedFetch(() => helloReply, []),
    eventSource: FakeEventSource as unknown as typeof EventSource,
  });
  const first: unknown[] = [];
  const second: unknown[] = [];
  const leaveFirst = client.subscribe("ui.notify", (frame) => first.push(frame.payload));
  const leaveSecond = client.subscribe("ui.notify", (frame) => second.push(frame.payload));

  assert.equal(FakeEventSource.instances.length, 1, "one stream serves both subscribers");
  const source = FakeEventSource.instances[0];
  source.emit(envelope("ui.notify", { message: "shared" }, { sequence: 1, cursor: "c1" }));
  assert.deepEqual(first, [{ message: "shared" }]);
  assert.deepEqual(second, [{ message: "shared" }]);

  leaveFirst();
  assert.equal(source.closed, false);
  source.emit(envelope("ui.notify", { message: "still live" }, { sequence: 2, cursor: "c2" }));
  assert.equal(second.length, 2);
  leaveSecond();
  assert.equal(source.closed, true);
});

test("directory events use the directory stream, independent of session events", () => {
  FakeEventSource.instances = [];
  const client = new ProtocolClient({
    sessionId: "s1",
    fetch: scriptedFetch(() => helloReply, []),
    eventSource: FakeEventSource as unknown as typeof EventSource,
  });
  const leaveSession = client.subscribe("ui.notify", () => {});
  const leaveDirectory = client.subscribe("ui.session.lifecycle", () => {});

  assert.equal(FakeEventSource.instances.length, 2);
  assert.match(FakeEventSource.instances[0].url, /\/api\/agent\/s1\/events$/);
  leaveSession();
  leaveDirectory();
});

test("resyncing from a cursor converges without duplicating transcript rows", () => {
  const source = sourceOf("use-session.ts");
  assert.match(source, /query<ResyncPage>\("session\.resync"/, "gap recovery uses the named resync query");
  assert.match(source, /applyPage\(page, "append"\)/, "the resync snapshot merges as an append");

  const loaded: HistoryEntryLike[] = [{
    role: "assistant",
    blocks: [{ kind: "text", text: "first" }],
  }];
  const page: HistoryEntryLike[] = [...loaded, {
    role: "assistant",
    blocks: [{ kind: "text", text: "second" }],
  }];

  const merged = mergeHistoryEntries(loaded, page, "append");

  assert.deepEqual(merged, [...loaded, page[1]], "the already-rendered row is absorbed into the resync page");
});

const sourceOf = (path: string): string => readFileSync(new URL(`../web/core/client/${path}`, import.meta.url), "utf8");

test("the directory client omits sessionId and posts to its own binding", async () => {
  const calls: FetchCall[] = [];
  const client = new ProtocolClient({
    sessionId: "",
    protocolPath: () => "/api/protocol",
    fetch: scriptedFetch((call) => {
      if (call.body.name === "bridge.hello") return helloReply;
      return { ok: true, value: { payload: { sessions: [] } } };
    }, calls),
  });

  const outcome = await client.query("session.list");

  assert.equal(outcome.ok, true);
  assert.deepEqual(calls.map((call) => call.url), ["/api/protocol", "/api/protocol"]);
  for (const call of calls) {
    assert.equal(JSON.stringify(call.body).includes("sessionId"), false, "session-less envelopes stay session-less");
  }
});

test("the shared directory client is a singleton", () => {
  assert.equal(directoryProtocolClient(), directoryProtocolClient());
});

test("request activity recognises protocol turn commands, not only legacy frames", () => {
  const source = sourceOf("request-activity.ts");
  assert.match(source, /TURN_MESSAGES = new Set\(\["session\.prompt", "web-command\.dispatch"\]\)/);
  assert.match(source, /PROTOCOL_PATH\.test\(path\)/);
});

test("client components leave pi routes to the protocol binding", () => {
  const routeCall = /(?:fetch|EventSource)\(\s*[`'"]\/?(?:api\/agent\/|api\/sessions(?:[`'"]|[?]))/;
  for (const file of [
    "use-session.ts",
    "shell.tsx",
    "composer.tsx",
    "dialogs.tsx",
    "new-session-dialog.tsx",
    "request-activity.ts",
  ]) {
    const source = sourceOf(file);
    assert.doesNotMatch(source, routeCall, `${file} must not post to a pi route`);
  }
});

test("the session hook uses named protocol messages for migrated reads and commands", () => {
  const source = sourceOf("use-session.ts");
  for (const name of [
    "session.list",
    "session.search",
    "session.get",
    "session.create",
    "session.models",
    "session.commands",
    "session.history",
    "session.resync",
    "session.tool-result",
    "session.events",
    "session.directory.events",
    "session.set-model",
    "session.set-thinking",
  ]) {
    assert.match(source, new RegExp(`["'\`]${name}["'\`]`), `missing protocol message ${name}`);
  }
});
