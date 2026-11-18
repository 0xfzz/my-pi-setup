import test from "node:test";
import assert from "node:assert/strict";

import type { BridgeCommand } from "../../server/bridge.ts";
import { createSessionAdapters, type SessionSurface } from "../../adapters/session.ts";
import { MESSAGE_CATALOG, type MessageDefinition } from "../catalog.ts";
import { parseEnvelope, type BridgeEnvelope } from "../envelope.ts";
import { BRIDGE_PROTOCOL, BRIDGE_PROTOCOL_VERSION, HELLO } from "../version.ts";
import { conformanceCases, runConformance } from "../testing/conformance.ts";
import { createInProcessBinding, type InProcessOptions } from "./in-process.ts";
import { createSessionAttachBinding } from "./session-attach.ts";
import type { BindingOptions, CapabilityAuditEntry } from "./types.ts";

const allCapabilities = (): string[] => {
  const definitions: readonly MessageDefinition[] = MESSAGE_CATALOG;
  return definitions.flatMap((message) => message.capability === undefined ? [] : [message.capability]);
};

const directory = {
  list: () => ({ sessions: [] }),
  create: ({ cwd }: { cwd?: string }) => ({ sessionId: "new-session", cwd: cwd ?? "/tmp" }),
  get: ({ id }: { id?: string }) => ({ session: { id } }),
  remove: ({ id }: { id?: string }) => ({ ok: true, id }),
  rename: ({ id, name }: { id?: string; name?: string }) => ({ ok: true, id, name }),
};

function options(name: BindingOptions["name"], granted = allCapabilities()): InProcessOptions {
  return {
    name, sessionId: "session-1", cwd: "/tmp", grantedCapabilities: granted,
    snapshot: () => ({ views: {}, revision: 1 }),
    directory,
    session: session(),
  };
}

function session(): SessionSurface {
  return {
    prompt: () => undefined,
    abort: () => undefined,
    setModel: () => true,
    setThinkingLevel: () => true,
    webCommand: () => undefined,
  };
}

function envelope(name: string, payload: unknown = {}, source: BridgeEnvelope["source"] = {
  type: "core", id: "test",
}): BridgeEnvelope {
  const parsed = parseEnvelope({
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_PROTOCOL_VERSION,
    kind: "command",
    name,
    messageId: `${name}-1`,
    source,
    timestamp: 0,
    payload,
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.envelope;
}

async function handshake(binding: { hello: ReturnType<typeof createInProcessBinding>["hello"] }): Promise<void> {
  const ack = await binding.hello({
    version: BRIDGE_PROTOCOL_VERSION,
    bindings: ["in-process", "session-attach", "http-sse"],
    clientId: "test",
    capabilities: [],
  });
  assert.equal(ack.ok, true);
}

test("the in-process binding passes the whole conformance suite", async () => {
  const binding = createInProcessBinding({ ...options("in-process"), session: session() });
  const report = await runConformance(binding);
  assert.deepEqual(report.failures, []);
  assert.equal(report.passed, conformanceCases().length);
  await binding.close();
});

test("a session-attach binding passes the same conformance suite", async () => {
  const commands: BridgeCommand[] = [];
  const binding = createSessionAttachBinding(options("session-attach"), {
    sendCommand: (command) => { commands.push(command); },
    getCommands: () => [],
    getModels: () => ({ models: [] }),
    getTreeNodes: () => [],
  });
  const report = await runConformance(binding);
  assert.deepEqual(report.failures, []);
  assert.equal(report.passed, conformanceCases().length);
  await binding.close();
});

test("commands and queries before the handshake are refused", async () => {
  const binding = createInProcessBinding({ ...options("in-process"), session: session() });
  const reply = await binding.invoke(envelope("session.prompt", { text: "hi" }));
  assert.equal(reply.ok, false);
  if (!reply.ok) assert.equal(reply.error.code, "INTERNAL");
  await handshake(binding);
  const prompt = await binding.invoke(envelope("session.prompt", { text: "hi" }));
  assert.equal(prompt.ok, true);
});

test("a plugin message without its capability is denied and named", async () => {
  const binding = createInProcessBinding({
    ...options("in-process", []),
    bridgeSlices: new Map([["evil.plugin", ["session.prompt"]]]),
    session: session(),
  });
  await handshake(binding);
  const reply = await binding.invoke(envelope("session.prompt", { text: "hi" }, {
    type: "plugin", id: "evil.plugin",
  }));
  assert.equal(reply.ok, false);
  if (!reply.ok) {
    assert.equal(reply.error.code, "CAPABILITY_DENIED");
    assert.deepEqual(reply.error.details, { plugin: "evil.plugin", capability: "session.write" });
  }
});

test("a declared core slice is used and an undeclared message is denied once", async () => {
  const audited: CapabilityAuditEntry[] = [];
  const binding = createInProcessBinding({
    ...options("in-process"),
    bridgeSlices: new Map([["acme.plugin", ["session.prompt"]]]),
    pluginGrants: allCapabilities(),
    audit: (entry) => { audited.push(entry); },
    session: session(),
  });
  await handshake(binding);
  const allowed = await binding.invoke(envelope("session.prompt", { text: "hi" }, {
    type: "plugin", id: "acme.plugin",
  }));
  assert.equal(allowed.ok, true);

  const denied = await binding.invoke(envelope("session.delete", {}, {
    type: "plugin", id: "acme.plugin",
  }));
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.error.code, "BRIDGE_MESSAGE_DENIED");
    assert.deepEqual(denied.error.details, { plugin: "acme.plugin", message: "session.delete" });
  }
  assert.deepEqual(audited, [{
    source: "acme.plugin", capability: "BRIDGE_MESSAGE_DENIED", message: "session.delete",
  }]);
  await binding.close();
});

test("an external plugin with no declared slice has no core messages", async () => {
  const binding = createInProcessBinding({
    ...options("in-process"),
    bridgeSlices: new Map(),
    session: session(),
  });
  await handshake(binding);
  const denied = await binding.invoke(envelope("session.list", {}, {
    type: "browser", id: "unknown.plugin",
  }));
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "BRIDGE_MESSAGE_DENIED");
  await binding.close();
});

test("session adapters forward bridge commands to the owning session", () => {
  const commands: BridgeCommand[] = [];
  const adapters = createSessionAdapters({
    prompt: (text) => { commands.push({ type: "prompt", message: text }); },
    abort: () => { commands.push({ type: "abort" }); },
    setModel: (provider, id) => { commands.push({ type: "set_model", provider, id }); return true; },
    setThinkingLevel: (level) => { commands.push({ type: "set_thinking", level }); return true; },
    webCommand: (name, args) => { commands.push({ type: "web_command", name, args }); },
  });
  void adapters["session.prompt"]({ cwd: "/tmp", grantedCapabilities: [] }, { text: "go" }, new AbortController().signal);
  void adapters["session.abort"]({ cwd: "/tmp", grantedCapabilities: [] }, {}, new AbortController().signal);
  assert.deepEqual(commands, [{ type: "prompt", message: "go" }, { type: "abort" }]);
});

test("a session-attach binding maps prompts onto bridge commands", async () => {
  const commands: BridgeCommand[] = [];
  const binding = createSessionAttachBinding(options("session-attach"), {
    sendCommand: (command) => { commands.push(command); },
  });
  await handshake({ hello: binding.hello });
  const reply = await binding.invoke(envelope("session.prompt", { text: "from browser" }));
  assert.equal(reply.ok, true);
  assert.deepEqual(commands, [{ type: "prompt", message: "from browser" }]);
  await binding.close();
});

test("HELLO is a catalog message handled by the handshake, not a prompt", () => {
  assert.equal(envelope(HELLO).name, HELLO);
});
