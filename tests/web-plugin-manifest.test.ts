import test from "node:test";
import assert from "node:assert/strict";

import { parseManifestText, validateManifest } from "../web/core/plugin-contracts/kernel/manifest.ts";
import { engineMismatch } from "../web/core/plugin-contracts/kernel/compat.ts";

const base = () => ({
  id: "acme.zen-chat",
  name: "Zen chat",
  version: "1.2.0",
  engines: { piWeb: "^1.0.0", sdk: "^1.0.0" },
  main: { server: "./server.ts" },
  trust: "trusted",
  capabilities: ["ui.slots", "ui.replace:chat.message.*", "session.read", "routes"],
  dependsOn: { "core.messages": "^1.0.0" },
  optionalDependsOn: { "acme.metrics": "^1.0.0" },
  activation: ["onStartup"],
});

function expectError(input: unknown, pattern: RegExp) {
  const result = validateManifest(input);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, pattern);
}

test("a complete manifest is accepted and normalised with defaults", () => {
  const result = validateManifest(base());
  assert.ok(result.ok);
  assert.equal(result.manifest.id, "acme.zen-chat");
  assert.equal(result.manifest.capabilities.length, 4);
  assert.deepEqual(result.manifest.optionalDependsOn, { "acme.metrics": "^1.0.0" });
});

test("a manifest with no trust field defaults to declarative and may not carry code", () => {
  const plain = { ...base(), trust: undefined };
  const ok = validateManifest({ ...plain, main: undefined });
  assert.ok(ok.ok);
  assert.equal(ok.manifest.trust, "declarative");
  expectError(plain, /declarative plugin cannot declare a code entry point/);
});

test("ids must be dotted lowercase segments", () => {
  for (const bad of ["Acme", "acme..x", "acme.", ".acme", "acme_x", "1acme"]) {
    expectError({ ...base(), id: bad }, /id must match/);
  }
  assert.ok(validateManifest({ ...base(), id: "core.compat" }).ok);
  assert.ok(validateManifest({ ...base(), id: "bubbly-spinner" }).ok);
});

test("unknown top-level fields are rejected, not silently ignored", () => {
  expectError({ ...base(), mystery: true }, /unknown manifest field\(s\): mystery/);
});

test("entry paths must stay inside the plugin directory", () => {
  expectError({ ...base(), main: { server: "../../etc/evil.ts" } }, /must be a \.\/relative path/);
  expectError({ ...base(), main: { server: "/abs/server.ts" } }, /must be a \.\/relative path/);
  expectError({ ...base(), main: { worker: "./w.ts" } }, /not a known entry point/);
});

test("trust tiers, engines and version are validated", () => {
  expectError({ ...base(), trust: "root" }, /trust must be/);
  expectError({ ...base(), version: "1.0" }, /strict semver/);
  expectError({ ...base(), engines: { piWeb: "^1.0.0" } }, /engines must declare/);
  expectError({ ...base(), engines: { piWeb: "^1.0.0", sdk: "!!" } }, /engines.sdk/);
});

test("ui.css is only accepted from a trusted plugin", () => {
  expectError({ ...base(), trust: "declarative", main: undefined, capabilities: ["ui.css"] }, /capability "ui.css" requires trust "trusted"/);
  assert.ok(validateManifest({ ...base(), trust: "trusted", capabilities: ["ui.css"] }).ok);
});

test("capabilities go through the grammar", () => {
  expectError({ ...base(), capabilities: ["ui.replace"] }, /requires an argument/);
  expectError({ ...base(), capabilities: ["teleport"] }, /unknown capability/);
});

test("dependency maps reject bad ids, bad ranges and self-dependence", () => {
  expectError({ ...base(), dependsOn: { "Core.Messages": "^1.0.0" } }, /invalid plugin id/);
  expectError({ ...base(), dependsOn: { "core.messages": "latest" } }, /not a valid semver range/);
  expectError({ ...base(), optionalDependsOn: { "acme.zen-chat": "^1.0.0" } }, /cannot depend on itself/);
});

test("activation events must be ones the kernel implements", () => {
  assert.ok(validateManifest({ ...base(), activation: ["onStartup"] }).ok);
  expectError({ ...base(), activation: ["onMagic"] }, /unsupported activation event "onMagic"/);
  expectError({ ...base(), activation: [] }, /non-empty array/);
});

test("parseManifestText turns JSON syntax errors into rejections", () => {
  const bad = parseManifestText("{ not json");
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /not valid JSON/);
  const good = parseManifestText(JSON.stringify(base()));
  assert.ok(good.ok);
});

test("an unimplemented activation event is refused, not accepted and ignored", () => {
  // Only onStartup is implemented: every other event would need a lazy
  // activation seam the kernel does not have.
  for (const event of ["onSession", "onRoute:/api/x", "onCommand:foo", "onSlotVisible:chat.composer"]) {
    expectError({ ...base(), activation: [event] }, /unsupported activation event/);
  }
  const ok = validateManifest({ ...base(), activation: ["onStartup"] });
  assert.equal(ok.ok, true);
});

test("a browser entry point is refused: no loader can serve one", () => {
  expectError({ ...base(), trust: "trusted", main: { browser: "./client.ts" } }, /main\.browser is not a known entry point/);
});

test("trust has no sandbox tier: a manifest cannot claim a guarantee the host lacks", () => {
  expectError({ ...base(), trust: "sandboxed" }, /trust must be one of declarative, trusted/);
});

test("engines ranges are checked against the host versions", () => {
  const ok = validateManifest(base());
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(engineMismatch(ok.manifest), undefined);

  const future = validateManifest({ ...base(), engines: { piWeb: "^2.0.0", sdk: "^1.0.0" } });
  assert.equal(future.ok, true);
  if (!future.ok) return;
  assert.match(engineMismatch(future.manifest) ?? "", /requires piWeb \^2\.0\.0; this host serves/);

  const oldSdk = validateManifest({ ...base(), engines: { piWeb: "^1.0.0", sdk: ">=0.5.0 <1.0.0" } });
  assert.equal(oldSdk.ok, true);
  if (!oldSdk.ok) return;
  assert.match(engineMismatch(oldSdk.manifest) ?? "", /requires sdk/);
});
