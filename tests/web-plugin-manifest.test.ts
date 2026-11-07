import test from "node:test";
import assert from "node:assert/strict";

import { parseManifestText, validateManifest } from "../lib/web-plugins/kernel/manifest.ts";

const base = () => ({
  id: "acme.zen-chat",
  name: "Zen chat",
  version: "1.2.0",
  engines: { piWeb: "^1.0.0", sdk: "^1.0.0" },
  main: { server: "./server.ts", browser: "./browser.tsx" },
  trust: "trusted",
  capabilities: ["ui.slots", "ui.replace:chat.message.*", "session.read", "routes"],
  dependsOn: { "core.messages": "^1.0.0" },
  optionalDependsOn: { "acme.metrics": "^1.0.0" },
  activation: ["onStartup", "onSessionKind:workflow", "onCommand:acme.zen.toggle"],
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
  expectError(plain, /declarative plugin cannot declare code entry points/);
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

test("capabilities go through the grammar", () => {
  expectError({ ...base(), capabilities: ["ui.replace"] }, /requires an argument/);
  expectError({ ...base(), capabilities: ["teleport"] }, /unknown capability/);
});

test("dependency maps reject bad ids, bad ranges and self-dependence", () => {
  expectError({ ...base(), dependsOn: { "Core.Messages": "^1.0.0" } }, /invalid plugin id/);
  expectError({ ...base(), dependsOn: { "core.messages": "latest" } }, /not a valid semver range/);
  expectError({ ...base(), optionalDependsOn: { "acme.zen-chat": "^1.0.0" } }, /cannot depend on itself/);
});

test("activation events must match the catalogued forms", () => {
  assert.ok(validateManifest({ ...base(), activation: ["onRoute:/stats"] }).ok);
  expectError({ ...base(), activation: ["onMagic"] }, /unknown activation event "onMagic"/);
  expectError({ ...base(), activation: [] }, /non-empty array/);
});

test("parseManifestText turns JSON syntax errors into rejections", () => {
  const bad = parseManifestText("{ not json");
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /not valid JSON/);
  const good = parseManifestText(JSON.stringify(base()));
  assert.ok(good.ok);
});
