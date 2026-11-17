import test from "node:test";
import assert from "node:assert/strict";

import { MESSAGE_NAMES, protocolInvoke } from "./catalog.ts";
import { ENVELOPE_MAX_BYTES, parseEnvelope, type BridgeEnvelope } from "./envelope.ts";
import { BRIDGE_PROTOCOL, BRIDGE_PROTOCOL_VERSION, HELLO, versionMismatch } from "./version.ts";

function helloEnvelope(overrides: Partial<BridgeEnvelope> = {}): BridgeEnvelope {
  return {
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_PROTOCOL_VERSION,
    kind: "capability",
    name: HELLO,
    messageId: "hello-1",
    source: { type: "browser", id: "web" },
    timestamp: 0,
    payload: {},
    ...overrides,
  };
}

test("a well-formed envelope round-trips through the validator", () => {
  const result = parseEnvelope(helloEnvelope({ sessionId: "session-1", sequence: 1, cursor: "c1" }));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.envelope, helloEnvelope({ sessionId: "session-1", sequence: 1, cursor: "c1" }));
});

test("unknown message names and missing extension ids are refused", () => {
  assert.equal(parseEnvelope(helloEnvelope({ name: "not.in.catalog" as BridgeEnvelope["name"] })).ok, false);
  assert.equal(parseEnvelope(helloEnvelope({ source: { type: "plugin", id: "" } })).ok, false);
  assert.equal(parseEnvelope(helloEnvelope({ source: { type: "extension", id: "my.ext" } })).ok, true);
});

test("hostile keys, terminal controls and non-finite numbers never cross", () => {
  const hostile = parseEnvelope(helloEnvelope({
    payload: JSON.parse('{"__proto__":{"polluted":true},"ok":1}'),
  }));
  assert.equal(hostile.ok, false);
  if (!hostile.ok) assert.equal(hostile.error.code, "VALIDATION_FAILED");

  const ansi = parseEnvelope(helloEnvelope({ payload: { text: "\u001b[31mred\u001b[0m" } }));
  assert.equal(ansi.ok, true);
  if (ansi.ok) assert.deepEqual(ansi.envelope.payload, { text: "red" });

  assert.equal(parseEnvelope(helloEnvelope({ payload: { value: Number.NaN } })).ok, false);
});

test("oversized envelopes are refused with a named error", () => {
  const result = parseEnvelope(helloEnvelope({ payload: { text: "x".repeat(ENVELOPE_MAX_BYTES) } }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "VALIDATION_FAILED");
});

test("a mismatch names both versions and is not retryable", () => {
  const error = versionMismatch(BRIDGE_PROTOCOL_VERSION + 1);
  assert.equal(error.code, "VERSION_MISMATCH");
  assert.equal(error.retryable, false);
  assert.deepEqual(error.details, { expected: BRIDGE_PROTOCOL_VERSION, received: BRIDGE_PROTOCOL_VERSION + 1 });
});

test("the catalog uses unique names and the invoke capability follows its grammar", () => {
  assert.equal(new Set(MESSAGE_NAMES).size, MESSAGE_NAMES.length);
  assert.equal(protocolInvoke("settings.write"), "protocol.invoke:settings.write");
});
