/**
 * Binding-neutral conformance suite. A binding under test must already have
 * every catalog capability granted; this harness never changes capability grants.
 */
import assert from "node:assert/strict";

import { type BindingName, type BindingReply, type ProtocolBinding } from "../bindings/types.ts";
import { MESSAGE_CATALOG, type MessageKind, type MessageName } from "../catalog.ts";
import { ENVELOPE_MAX_BYTES, parseEnvelope, type BridgeEnvelope } from "../envelope.ts";
import type { BridgeErrorCode } from "../errors.ts";
import { BRIDGE_PROTOCOL, BRIDGE_PROTOCOL_VERSION, HELLO, type Hello } from "../version.ts";

export interface ConformanceCase {
  readonly id: string;
  readonly description: string;
  run(binding: ProtocolBinding): Promise<void>;
}

export interface ConformanceReport {
  readonly passed: number;
  readonly failures: Array<{ id: string; error: string }>;
}

const CONFORMANCE_CLIENT_ID = "conformance";
const UNKNOWN_MESSAGE_NAME = "conformance.unknown-message";
const FOREIGN_PROTOCOL = "not-pi-web-bridge";

function catalogEnvelope(name: MessageName, kind: MessageKind): BridgeEnvelope {
  const parsed = parseEnvelope({
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_PROTOCOL_VERSION,
    kind,
    name,
    messageId: `conformance:${name}`,
    source: { type: "core", id: CONFORMANCE_CLIENT_ID },
    timestamp: 0,
    payload: {},
  });
  if (!parsed.ok) assert.fail(`conformance envelope for ${name} is invalid: ${parsed.error.message}`);
  return parsed.envelope;
}

function assertOkReply(reply: BindingReply, label: string): void {
  if (!reply.ok) assert.fail(`${label}: binding rejected the envelope (${reply.error.code}: ${reply.error.message})`);
  const parsed = parseEnvelope(reply.value);
  if (!parsed.ok) assert.fail(`${label}: reply is not a valid envelope (${parsed.error.message})`);
}

/** Rejection cases deliberately send invalid data across the typed binding seam. */
function invokeUnchecked(binding: ProtocolBinding, input: unknown): Promise<BindingReply> {
  return binding.invoke(input as BridgeEnvelope);
}

async function assertRejected(
  binding: ProtocolBinding,
  input: unknown,
  codes: readonly BridgeErrorCode[],
  label: string,
): Promise<void> {
  const reply = await invokeUnchecked(binding, input);
  if (reply.ok) assert.fail(`${label}: binding accepted an invalid envelope`);
  assert.ok(codes.includes(reply.error.code), `${label}: expected ${codes.join(" or ")}, got ${reply.error.code}`);
}

async function runCatalogCase(binding: ProtocolBinding, name: MessageName, kind: MessageKind): Promise<void> {
  assertOkReply(await binding.invoke(catalogEnvelope(name, kind)), `catalog:${name}`);
}

interface RejectionCase {
  readonly id: string;
  readonly description: string;
  readonly input: () => unknown;
  readonly codes: readonly BridgeErrorCode[];
}

const hostilePayload = (): unknown => JSON.parse('{"__proto__":{"polluted":true},"ok":1}');

const REJECTION_CASES: readonly RejectionCase[] = [
  {
    id: "malformed:protocol",
    description: "A foreign protocol string is refused.",
    input: () => ({ ...catalogEnvelope(HELLO, "capability"), protocol: FOREIGN_PROTOCOL }),
    codes: ["VALIDATION_FAILED"],
  },
  {
    id: "malformed:version",
    description: "A future protocol version is refused with VERSION_MISMATCH.",
    input: () => ({ ...catalogEnvelope(HELLO, "capability"), version: BRIDGE_PROTOCOL_VERSION + 1 }),
    codes: ["VERSION_MISMATCH"],
  },
  {
    id: "malformed:unknown-message",
    description: "A message name outside the catalog is refused.",
    input: () => ({ ...catalogEnvelope(HELLO, "capability"), name: UNKNOWN_MESSAGE_NAME }),
    codes: ["UNKNOWN_MESSAGE", "VALIDATION_FAILED"],
  },
  {
    id: "malformed:hostile-key",
    description: "A __proto__ key in the payload is refused.",
    input: () => ({ ...catalogEnvelope(HELLO, "capability"), payload: hostilePayload() }),
    codes: ["VALIDATION_FAILED"],
  },
  {
    id: "malformed:oversized-payload",
    description: "A payload beyond the envelope byte limit is refused.",
    input: () => ({ ...catalogEnvelope(HELLO, "capability"), payload: { text: "x".repeat(ENVELOPE_MAX_BYTES) } }),
    codes: ["VALIDATION_FAILED"],
  },
  {
    id: "malformed:plugin-source-id",
    description: "A plugin source without an id is refused.",
    input: () => ({ ...catalogEnvelope(HELLO, "capability"), source: { type: "plugin" } }),
    codes: ["VALIDATION_FAILED"],
  },
];

/** TypeBox's Static inference collapses the literal binding union to never. */
type HelloInput = Omit<Hello, "bindings"> & { readonly bindings: readonly BindingName[] };

function helloFor(binding: ProtocolBinding): Hello {
  const input: HelloInput = {
    version: BRIDGE_PROTOCOL_VERSION,
    bindings: [binding.name],
    clientId: CONFORMANCE_CLIENT_ID,
    capabilities: [],
  };
  return input as Hello;
}

async function runHandshake(binding: ProtocolBinding): Promise<void> {
  const reply = await binding.hello(helloFor(binding));
  if (!reply.ok) assert.fail(`handshake: hello was rejected (${reply.error.code}: ${reply.error.message})`);
  assert.equal(reply.value.version, BRIDGE_PROTOCOL_VERSION, "handshake: ack version must match the host");
}

function assertUniqueKeys(keys: readonly string[], label: string): void {
  assert.equal(new Set(keys).size, keys.length, `${label} must not contain duplicates`);
}

async function runSequenceCursor(binding: ProtocolBinding): Promise<void> {
  const first = binding.events();
  const second = binding.events();
  assert.deepEqual(second, first, "sequence-cursor: events() snapshots must be stable across two reads");
  const cursors = first.flatMap((event) => event.cursor === undefined ? [] : [event.cursor]);
  assertUniqueKeys(cursors, "sequence-cursor: event cursors");
  const channels = first.flatMap((event) => event.sequence === undefined
    ? []
    : [`${event.sessionId ?? ""}:${event.name}:${event.sequence}`]);
  assertUniqueKeys(channels, "sequence-cursor: per-channel event sequences");
}

export function conformanceCases(): readonly ConformanceCase[] {
  return [
    // Handshake first: bindings refuse commands before an ack by design.
    {
      id: "handshake",
      description: "hello returns an ack on the host protocol version.",
      run: runHandshake,
    },
    ...MESSAGE_CATALOG.map((message): ConformanceCase => ({
      id: `catalog:${message.name}`,
      description: `${message.name} accepts a valid ${message.kind} envelope.`,
      run: (binding) => runCatalogCase(binding, message.name, message.kind),
    })),
    ...REJECTION_CASES.map((spec): ConformanceCase => ({
      id: spec.id,
      description: spec.description,
      run: (binding) => assertRejected(binding, spec.input(), spec.codes, spec.id),
    })),
    {
      id: "sequence-cursor",
      description: "event snapshots stay stable and never repeat cursors or channel sequences.",
      run: runSequenceCursor,
    },
  ];
}

export async function runConformance(binding: ProtocolBinding): Promise<ConformanceReport> {
  const failures: Array<{ id: string; error: string }> = [];
  let passed = 0;
  for (const testCase of conformanceCases()) {
    try {
      await testCase.run(binding);
      passed += 1;
    } catch (error) {
      failures.push({ id: testCase.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { passed, failures };
}
