/** Regressions for the HTTP host's handshake and source-attribution failures. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseEnvelope, type BridgeEnvelope } from "../envelope.ts";
import { BRIDGE_PROTOCOL, BRIDGE_PROTOCOL_VERSION, HELLO } from "../version.ts";
import {
  createDirectoryProtocolHost,
  createProtocolHost,
  decodeProtocolCursor,
  encodeProtocolCursor,
  type ProtocolHostOptions,
} from "../../server/protocol-host.ts";
import type { SessionSurface } from "../../adapters/session.ts";
import { conformanceCases, runConformance } from "../testing/conformance.ts";
import { createHttpSseBinding } from "./http-sse.ts";
import { registerSession, clearSessionsForTests, type SessionCore } from "../../server/sessions.ts";
import { protocolEvent } from "../../server/event-stream.ts";
import { decodeHistoryCursor } from "../../../../lib/history-cursor.ts";

const session: SessionSurface = {
  prompt: () => undefined,
  abort: () => undefined,
};

function options(grants: string[] = ["session.read", "session.write", "protocol.invoke:*"]): ProtocolHostOptions {
  return {
    sessionId: "session-1",
    cwd: "/tmp",
    grantedCapabilities: grants,
    session,
    snapshot: () => ({ views: {}, revision: 1 }),
  };
}

function envelope(name: string, source: BridgeEnvelope["source"], version = BRIDGE_PROTOCOL_VERSION): BridgeEnvelope {
  const parsed = parseEnvelope({
    protocol: BRIDGE_PROTOCOL,
    version,
    kind: name === HELLO ? "capability" : "query",
    name,
    messageId: `http-${name}`,
    sessionId: "session-1",
    source,
    timestamp: 0,
    payload: name === HELLO
      ? { version, bindings: ["http-sse"], clientId: source.id, capabilities: [] }
      : {},
  });
  if (!parsed.ok) assert.fail(parsed.error.message);
  return parsed.envelope;
}

const browser = (id: string): BridgeEnvelope["source"] => ({ type: "browser", id });

function directoryEnvelope(name: string, sessionId?: string, version = BRIDGE_PROTOCOL_VERSION): BridgeEnvelope {
  const parsed = parseEnvelope({
    protocol: BRIDGE_PROTOCOL,
    version,
    kind: name === HELLO ? "capability" : name === "session.create" ? "command" : "query",
    name,
    messageId: `directory-${name}`,
    ...(sessionId === undefined ? {} : { sessionId }),
    source: browser("directory-client"),
    timestamp: 0,
    payload: name === HELLO
      ? { version, bindings: ["http-sse"], clientId: "directory-client", capabilities: [] }
      : { query: "project" },
  });
  if (!parsed.ok) assert.fail(parsed.error.message);
  return parsed.envelope;
}

test("the http-sse binding passes the same conformance suite as the other bindings", async () => {
  const binding = createHttpSseBinding({
    name: "http-sse",
    sessionId: "session-1",
    cwd: "/tmp",
    clientId: "browser-client",
    grantedCapabilities: ["session.read", "session.write", "ui.publish", "commands", "protocol.invoke:*", "events.subscribe:*"],
    snapshot: () => ({ views: {}, revision: 1 }),
    directory: {
      list: () => ({ sessions: [] }),
      create: ({ cwd }) => ({ sessionId: "new-session", cwd: cwd ?? "/tmp" }),
      get: ({ id }) => ({ session: { id } }),
      remove: ({ id }) => ({ ok: true, id }),
      rename: ({ id, name }) => ({ ok: true, id, name }),
    },
    session,
  });
  const report = await runConformance(binding);
  assert.deepEqual(report.failures, []);
  assert.equal(report.passed, conformanceCases().length);
  await binding.close();
});

test("a browser command succeeds with a host grant and is denied without one", async () => {
  const granted = createProtocolHost(options());
  const hello = await granted.handle(envelope(HELLO, browser("browser-a")));
  assert.equal(hello.ok, true);
  const accepted = await granted.handle(envelope("session.prompt", browser("browser-a")));
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.equal(accepted.value.target?.type, "browser");

  const refused = createProtocolHost(options([]));
  assert.equal((await refused.handle(envelope(HELLO, browser("browser-b")))).ok, true);
  const denied = await refused.handle(envelope("session.prompt", browser("browser-b")));
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "CAPABILITY_DENIED");
  assert.equal(refused.denials().length, 1);
});

test("hello is enforced per client: a second browser cannot ride the first browser's handshake", async () => {
  const host = createProtocolHost(options());
  assert.equal((await host.handle(envelope(HELLO, browser("browser-a")))).ok, true);
  const before = await host.handle(envelope("session.prompt", browser("browser-b")));
  assert.equal(before.ok, false);
  if (!before.ok) assert.equal(before.error.code, "INTERNAL");
  assert.equal((await host.handle(envelope(HELLO, browser("browser-b")))).ok, true);
  assert.equal((await host.handle(envelope("session.prompt", browser("browser-b")))).ok, true);
});

test("a version mismatch is named before any command is dispatched", async () => {
  const host = createProtocolHost(options());
  const mismatch = await host.handle(envelope(HELLO, browser("browser-a"), BRIDGE_PROTOCOL_VERSION + 1));
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error.code, "VERSION_MISMATCH");
  const command = await host.handle(envelope("session.prompt", browser("browser-a")));
  assert.equal(command.ok, false);
  if (!command.ok) assert.equal(command.error.code, "INTERNAL");
  const forged = await host.handle(envelope("session.prompt", browser("browser-a"), BRIDGE_PROTOCOL_VERSION + 1));
  assert.equal(forged.ok, false);
  if (!forged.ok) assert.equal(forged.error.code, "VERSION_MISMATCH");
});

test("the directory route accepts session-less list/create and refuses a selected session", async () => {
  const host = createDirectoryProtocolHost({
    ...options(),
    directory: {
      list: ({ query }) => ({ sessions: [], query }),
      create: ({ cwd }) => ({ sessionId: "new-session", cwd: cwd ?? process.cwd() }),
      get: ({ id }) => ({ session: { id } }),
      remove: ({ id }) => ({ ok: true, id }),
      rename: ({ id, name }) => ({ ok: true, id, name }),
    },
  });
  assert.equal((await host.handle(directoryEnvelope(HELLO))).ok, true);
  const listed = await host.handle(directoryEnvelope("session.list"));
  assert.equal(listed.ok, true);
  const created = await host.handle(directoryEnvelope("session.create"));
  assert.equal(created.ok, true);
  if (created.ok) assert.equal(created.value.name, "session.create");
  const selected = await host.handle(directoryEnvelope("session.list", "some-session"));
  assert.equal(selected.ok, false);
  if (!selected.ok) assert.equal(selected.error.code, "VALIDATION_FAILED");
});

test("the opaque resync cursor round-trips and session.resync keeps the history shape", async () => {
  const cursor = encodeProtocolCursor({ sequence: 7, offset: 1024 });
  assert.deepEqual(decodeProtocolCursor(cursor), { sequence: 7, offset: 1024 });
  assert.equal(decodeProtocolCursor("h1:1024"), undefined);
  const page = {
    entries: [{ role: "user", blocks: [] }],
    toolResults: {},
    olderCursor: "older",
    newerCursor: "newer",
    hasOlder: false,
    cursor,
  };
  const host = createProtocolHost({ ...options(), session: { ...session, resync: () => page } });
  assert.equal((await host.handle(envelope(HELLO, browser("resync-client")))).ok, true);
  const result = await host.handle(envelope("session.resync", browser("resync-client")));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.payload, page);
});

test("a browser cannot claim a core or host source through the protocol route", async () => {
  const host = createProtocolHost(options());
  for (const forged of [{ type: "core", id: "pi-kernel" }, { type: "host", id: "protocol-host" }] as const) {
    // The route keys the handshake on the claimed client id: an unrelated
    // identity has no binding and cannot ride an earlier browser's hello.
    const withoutHello = await host.handle(envelope("session.prompt", forged));
    assert.equal(withoutHello.ok, false);
    assert.equal((await host.handle(envelope(HELLO, browser(forged.id)))).ok, true);
    const result = await host.handle(envelope("session.prompt", forged));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value.target, browser(forged.id));
  }
});

test("session.resync reads the real history store and returns a paged snapshot with an opaque cursor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-protocol-resync-"));
  const file = join(dir, "session.jsonl");
  await writeFile(file, `${JSON.stringify({ type: "message", message: { role: "user", content: "hello pi" } })}\n`);
  const id = "resync-real-session";
  const core: SessionCore = {
    sessionId: id,
    subscribe: () => () => undefined,
    prompt: async () => undefined,
    abort: async () => undefined,
    isStreaming: () => false,
    getState: () => ({
      sessionId: id,
      sessionFile: file,
      isStreaming: false,
      isBashRunning: false,
      isCompacting: false,
      model: { provider: "test", id: "model" },
      contextUsage: null,
      thinkingLevel: "off",
    }),
  };
  registerSession(core, dir, file);
  try {
    const host = createProtocolHost({ ...options(), session: undefined, sessionId: id, cwd: dir });
    assert.equal((await host.handle(envelope(HELLO, browser("resync-real")))).ok, true);
    const result = await host.handle(envelope("session.resync", browser("resync-real")));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const page = result.value.payload as {
      sessionId: string; entries: unknown[]; toolResults: unknown;
      olderCursor: string; newerCursor: string; hasOlder: boolean; cursor: string;
    };
    assert.equal(page.sessionId, id);
    assert.equal(page.entries.length, 1);
    assert.deepEqual(page.toolResults, {});
    assert.equal(typeof page.olderCursor, "string");
    assert.equal(typeof page.newerCursor, "string");
    assert.equal(typeof page.hasOlder, "boolean");
    assert.deepEqual(decodeProtocolCursor(page.cursor), { sequence: 1, offset: decodeHistoryCursor(page.newerCursor) });
  } finally {
    clearSessionsForTests();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SSE protocol events carry the catalog name, sequence and cursor", () => {
  const event = protocolEvent("session.events", "session-1", { type: "agent_start" }, 3);
  assert.equal(event.name, "session.events");
  assert.equal(event.kind, "event");
  assert.equal(event.sessionId, "session-1");
  assert.equal(event.sequence, 3);
  assert.equal(event.cursor, "3");
  assert.equal(event.source.type, "host");
  const directory = protocolEvent("session.directory.events", undefined, { type: "session_added" }, 2);
  assert.equal(directory.sessionId, undefined);
  assert.equal(directory.cursor, "2");
});
