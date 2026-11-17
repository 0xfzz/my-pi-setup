import test from "node:test";
import assert from "node:assert/strict";

import type { BindingName, BindingReply, ProtocolBinding } from "../bindings/types.ts";
import { lookupMessage, MESSAGE_CATALOG, type MessageName } from "../catalog.ts";
import { parseEnvelope, type BridgeEnvelope } from "../envelope.ts";
import { bridgeError } from "../errors.ts";
import { BRIDGE_PROTOCOL, BRIDGE_PROTOCOL_VERSION, type Hello, type HelloAck } from "../version.ts";
import { conformanceCases, runConformance } from "./conformance.ts";

function eventEnvelope(name: MessageName, sequence: number, cursor: string): BridgeEnvelope {
  const parsed = parseEnvelope({
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_PROTOCOL_VERSION,
    kind: "event",
    name,
    messageId: `event:${cursor}`,
    source: { type: "core", id: "conformance" },
    timestamp: 0,
    payload: {},
    sequence,
    cursor,
  });
  if (!parsed.ok) assert.fail(`test event ${cursor} is invalid: ${parsed.error.message}`);
  return parsed.envelope;
}

const DEFAULT_EVENTS: readonly BridgeEnvelope[] = [
  eventEnvelope("ui.notify", 1, "cursor-1"),
  eventEnvelope("ui.status.changed", 1, "cursor-2"),
];

interface FakeOptions {
  readonly deniedName?: string;
  readonly ackVersion?: number;
  readonly events?: readonly BridgeEnvelope[];
  readonly unstableEvents?: boolean;
}

/** In-memory binding: accepts catalog rows, refuses malformed envelopes. */
class FakeBinding implements ProtocolBinding {
  readonly name: BindingName = "in-process";
  readonly deniedName?: string;
  readonly ackVersion: number;
  private readonly buffered: readonly BridgeEnvelope[];
  private readonly unstableEvents: boolean;
  private reads = 0;

  constructor(options: FakeOptions = {}) {
    this.deniedName = options.deniedName;
    this.ackVersion = options.ackVersion ?? BRIDGE_PROTOCOL_VERSION;
    this.buffered = options.events ?? DEFAULT_EVENTS;
    this.unstableEvents = options.unstableEvents ?? false;
  }

  async hello(hello: Hello): Promise<BindingReply<HelloAck>> {
    return {
      ok: true,
      value: {
        version: this.ackVersion,
        bindings: hello.bindings,
        capabilities: hello.capabilities,
        sessionId: "conformance-session",
        cursor: "cursor-1",
      },
    };
  }

  async invoke(envelope: BridgeEnvelope): Promise<BindingReply> {
    if (envelope.protocol !== BRIDGE_PROTOCOL) {
      return { ok: false, error: bridgeError("VALIDATION_FAILED", "foreign protocol") };
    }
    if (envelope.version !== BRIDGE_PROTOCOL_VERSION) {
      return { ok: false, error: bridgeError("VERSION_MISMATCH", `expected v${BRIDGE_PROTOCOL_VERSION}`) };
    }
    if (!lookupMessage(envelope.name)) {
      return { ok: false, error: bridgeError("UNKNOWN_MESSAGE", `unknown message ${envelope.name}`) };
    }
    if (envelope.name === this.deniedName) {
      return { ok: false, error: bridgeError("CAPABILITY_DENIED", `no grant for ${envelope.name}`) };
    }
    const parsed = parseEnvelope(envelope);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return { ok: true, value: parsed.envelope };
  }

  events(): readonly BridgeEnvelope[] {
    if (this.unstableEvents) {
      this.reads += 1;
      return [...this.buffered, eventEnvelope("ui.notify", this.reads + 2, `late-${this.reads}`)];
    }
    return [...this.buffered];
  }

  async close(): Promise<void> {}
}

function hasHostileKey(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && Object.hasOwn(payload, "__proto__");
}

/** Rejects bad input, but reports the wrong error codes on three paths. */
class MisreportingBinding extends FakeBinding {
  async invoke(envelope: BridgeEnvelope): Promise<BindingReply> {
    if (envelope.version !== BRIDGE_PROTOCOL_VERSION) {
      return { ok: false, error: bridgeError("VALIDATION_FAILED", "wrong version") };
    }
    if (!lookupMessage(envelope.name)) {
      return { ok: false, error: bridgeError("CAPABILITY_DENIED", `unknown message ${envelope.name}`) };
    }
    if (hasHostileKey(envelope.payload)) {
      return { ok: false, error: bridgeError("RATE_LIMITED", "hostile key") };
    }
    return super.invoke(envelope);
  }
}

const EDGE_CASE_IDS = [
  "malformed:protocol",
  "malformed:version",
  "malformed:unknown-message",
  "malformed:hostile-key",
  "malformed:oversized-payload",
  "malformed:plugin-source-id",
  "handshake",
  "sequence-cursor",
];

function failedIds(failures: ReadonlyArray<{ id: string; error: string }>): readonly string[] {
  return failures.map((failure) => failure.id);
}

function failureFor(
  failures: ReadonlyArray<{ id: string; error: string }>,
  id: string,
): string {
  const failure = failures.find((entry) => entry.id === id);
  assert.ok(failure, `expected a failure named ${id}`);
  return failure.error;
}

test("conformance cases cover every catalog row and every required edge case", () => {
  const cases = conformanceCases();
  const ids = cases.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "case ids must be unique");
  for (const message of MESSAGE_CATALOG) {
    assert.ok(ids.includes(`catalog:${message.name}`), `missing case for ${message.name}`);
  }
  for (const id of EDGE_CASE_IDS) assert.ok(ids.includes(id), `missing case ${id}`);
  assert.equal(cases.length, MESSAGE_CATALOG.length + EDGE_CASE_IDS.length);
  for (const entry of cases) assert.ok(entry.description.length > 0, entry.id);
});

test("a binding that accepts the catalog passes the whole suite cleanly", async () => {
  const report = await runConformance(new FakeBinding());
  assert.deepEqual(report.failures, []);
  assert.equal(report.passed, conformanceCases().length);
});

test("version, unknown message, hostile key and capability denial are named failures", async () => {
  const deniedName = "settings.read";
  const report = await runConformance(new MisreportingBinding({ deniedName }));
  const repeated = await runConformance(new MisreportingBinding({ deniedName }));
  assert.deepEqual(repeated, report, "reports must be stable across runs");

  assert.equal(report.passed, conformanceCases().length - 4);
  assert.deepEqual([...failedIds(report.failures)].sort(), [
    "malformed:version",
    "malformed:unknown-message",
    "malformed:hostile-key",
    `catalog:${deniedName}`,
  ].sort());
  assert.match(failureFor(report.failures, "malformed:version"), /expected VERSION_MISMATCH, got VALIDATION_FAILED/);
  assert.match(failureFor(report.failures, "malformed:unknown-message"), /UNKNOWN_MESSAGE or VALIDATION_FAILED, got CAPABILITY_DENIED/);
  assert.match(failureFor(report.failures, "malformed:hostile-key"), /expected VALIDATION_FAILED, got RATE_LIMITED/);
  assert.match(failureFor(report.failures, `catalog:${deniedName}`), /CAPABILITY_DENIED/);
});

test("an ack on the wrong protocol version fails only the handshake case", async () => {
  const report = await runConformance(new FakeBinding({ ackVersion: BRIDGE_PROTOCOL_VERSION + 1 }));
  assert.deepEqual(failedIds(report.failures), ["handshake"]);
  assert.match(failureFor(report.failures, "handshake"), /ack version must match/);
});

test("duplicate event cursors fail the sequence-cursor case", async () => {
  const events = [
    eventEnvelope("ui.notify", 1, "cursor-1"),
    eventEnvelope("ui.status.changed", 2, "cursor-1"),
  ];
  const report = await runConformance(new FakeBinding({ events }));
  assert.deepEqual(failedIds(report.failures), ["sequence-cursor"]);
  assert.match(failureFor(report.failures, "sequence-cursor"), /must not contain duplicates/);
});

test("a drifting event snapshot fails the sequence-cursor case", async () => {
  const report = await runConformance(new FakeBinding({ unstableEvents: true }));
  assert.deepEqual(failedIds(report.failures), ["sequence-cursor"]);
  assert.match(failureFor(report.failures, "sequence-cursor"), /snapshots must be stable/);
});
