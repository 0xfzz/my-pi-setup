import test from "node:test";
import assert from "node:assert/strict";

import {
  CapabilityError,
  assertGranted,
  resolveGrants,
  formatCapability,
  grantCovers,
  hasWildcard,
  isGranted,
  parseCapability,
  validateCapabilities,
  type Capability,
} from "../web/core/plugin-contracts/kernel/capabilities.ts";

const cap = (text: string): Capability => {
  const parsed = parseCapability(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

test("parseCapability enforces each kind's argument rule", () => {
  assert.deepEqual(cap("routes"), { kind: "routes" });
  assert.deepEqual(cap("ui.replace:chat.message.*"), { kind: "ui.replace", arg: "chat.message.*" });
  assert.deepEqual(cap("storage:project"), { kind: "storage", arg: "project" });
  assert.equal(parseCapability("routes:x").ok, false, "routes takes no argument");
  assert.equal(parseCapability("ui.replace").ok, false, "ui.replace requires an argument");
  assert.equal(parseCapability("teleport").ok, false, "unknown kinds are rejected");
  assert.equal(parseCapability("").ok, false);
  assert.equal(parseCapability(42).ok, false);
  assert.equal(parseCapability("fs.read:../../etc").ok, false, "path-like arguments are rejected by the grammar");
  assert.deepEqual(cap("protocol.invoke:settings.write"), { kind: "protocol.invoke", arg: "settings.write" });
  assert.equal(parseCapability("protocol.invoke").ok, false, "a protocol call must name its message");
});

test("validateCapabilities dedupes, preserves order and rejects the whole list on one bad entry", () => {
  const ok = validateCapabilities(["routes", "storage", "routes"]);
  assert.ok(ok.ok);
  assert.deepEqual(ok.value.map(formatCapability), ["routes", "storage"]);
  assert.equal(validateCapabilities(["routes", "bogus"]).ok, false);
  assert.equal(validateCapabilities("routes").ok, false);
});

test("a grant without argument covers the kind; a glob grant covers matching arguments only", () => {
  assert.equal(grantCovers(cap("storage"), cap("storage:project")), true);
  assert.equal(grantCovers(cap("storage:project"), cap("storage")), false);
  assert.equal(grantCovers(cap("ui.replace:chat.message.*"), cap("ui.replace:chat.message.assistant")), true);
  assert.equal(grantCovers(cap("ui.replace:chat.message.*"), cap("ui.replace:chat.tool.bash")), false);
  assert.equal(grantCovers(cap("ui.replace:*"), cap("ui.replace:chat.message.assistant")), true);
  assert.equal(grantCovers(cap("ui.replace:chat.message.assistant"), cap("ui.replace:chat.message.assistantX")), false);
  assert.equal(grantCovers(cap("routes"), cap("storage")), false);
});

test("a grant argument with regex metacharacters matches literally", () => {
  assert.equal(grantCovers(cap("ui.replace:chat.message.*"), cap("ui.replace:chatXmessageYassistant")), false);
  assert.equal(grantCovers(cap("net:api.example.com"), cap("net:api.example.com")), true);
  assert.equal(grantCovers(cap("net:api.example.com"), cap("net:apiXexampleXcom")), false);
});

test("assertGranted throws CapabilityError naming plugin and capability", () => {
  const granted = [cap("routes")];
  assert.doesNotThrow(() => assertGranted("acme.zen", granted, cap("routes")));
  assert.throws(
    () => assertGranted("acme.zen", granted, cap("session.write")),
    (error: unknown) =>
      error instanceof CapabilityError &&
      error.plugin === "acme.zen" &&
      error.capability === "session.write" &&
      /acme\.zen/.test(error.message) &&
      /session\.write/.test(error.message),
  );
});

const REQUESTED = ["routes", "exec", "storage", "fs.read:/tmp", "hooks.veto:file.before-read", "session.read"];

function requested(capabilities: string[] = REQUESTED) {
  const parsed = validateCapabilities(capabilities);
  assert.ok(parsed.ok);
  return parsed.value;
}

test("an outside plugin gets the interface capabilities and must ask for the rest", () => {
  const { granted, pending } = resolveGrants(requested(), { inHostTree: false, confirmed: [] });
  assert.deepEqual(granted.map(formatCapability), ["routes", "storage", "session.read"]);
  assert.deepEqual(pending.map(formatCapability), ["exec", "fs.read:/tmp", "hooks.veto:file.before-read"]);
  assert.equal(isGranted(granted, cap("exec")), false);
  assert.equal(isGranted(granted, cap("protocol.invoke:settings.write")), false, "invoking a protocol message needs a grant");
});

test("a plugin in the host's own tree is trusted with what it asks for", () => {
  const { granted, pending } = resolveGrants(requested(), { inHostTree: true, confirmed: [] });
  assert.deepEqual(pending, []);
  assert.equal(isGranted(granted, cap("exec")), true);
});

test("an operator grant moves one sensitive capability out of pending", () => {
  const { granted, pending } = resolveGrants(requested(), { inHostTree: false, confirmed: ["fs.read:/tmp"] });
  assert.deepEqual(granted.map(formatCapability), ["routes", "storage", "fs.read:/tmp", "session.read"]);
  assert.deepEqual(pending.map(formatCapability), ["exec", "hooks.veto:file.before-read"]);
});

test("a grant the manifest never requested is ignored", () => {
  const { granted, pending } = resolveGrants(requested(["routes"]), {
    inHostTree: false,
    confirmed: ["exec", "net:https://example.com"],
  });
  assert.deepEqual(granted.map(formatCapability), ["routes"]);
  assert.deepEqual(pending, []);
});

test("hasWildcard flags glob grants for the confirmation prompt", () => {
  assert.equal(hasWildcard(cap("ui.replace:chat.message.*")), true);
  assert.equal(hasWildcard(cap("ui.replace:chat.message.assistant")), false);
  assert.equal(hasWildcard(cap("routes")), false);
});
