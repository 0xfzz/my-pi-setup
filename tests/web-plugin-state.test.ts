import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultState,
  loadState,
  markActivating,
  parseState,
  recordBoot,
  recoverInterruptedActivation,
  saveState,
  setPluginState,
  SAFE_MODE_WINDOW_MS,
} from "../lib/web-plugins/kernel/state.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "web-plugin-state-"));
}

test("a missing state file loads as defaults without a warning", () => {
  const dir = tempDir();
  try {
    const loaded = loadState(join(dir, "web-plugins.json"));
    assert.deepEqual(loaded, { state: defaultState() });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state round-trips through an atomic save and leaves no temp files behind", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "nested", "web-plugins.json");
    const state = setPluginState(defaultState(), "acme.zen", { enabled: true, grants: ["routes", "ui.replace:chat.message.*"] });
    saveState(path, state);
    assert.deepEqual(loadState(path).state, state);
    assert.deepEqual(readdirSync(join(dir, "nested")), ["web-plugins.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt or invalid file loads as defaults and says why", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "web-plugins.json");
    writeFileSync(path, "{ broken");
    const bad = loadState(path);
    assert.deepEqual(bad.state, defaultState());
    assert.match(bad.warning ?? "", /not valid JSON/);

    writeFileSync(path, JSON.stringify({ version: 1, plugins: { "acme.zen": { enabled: "yes", grants: [] } }, boots: [], activating: [] }));
    const malformed = loadState(path);
    assert.deepEqual(malformed.state, defaultState());
    assert.match(malformed.warning ?? "", /plugins\["acme\.zen"\] is malformed/);
    assert.equal(readFileSync(path, "utf8").includes("broken"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseState rejects unknown versions and keeps only well-typed fields", () => {
  assert.equal(parseState({ version: 2, plugins: {} }).ok, false);
  const ok = parseState({ version: 1, plugins: {}, boots: [1, "x", 3], activating: ["a", 7] });
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.state.boots, [1, 3]);
  assert.deepEqual(ok.ok && ok.state.activating, ["a"]);
});

test("two starts inside the window enter safe mode; one start does not", () => {
  const first = recordBoot(defaultState(), 1_000_000);
  assert.equal(first.safeMode, false);
  const second = recordBoot(first.state, 1_000_000 + 10_000);
  assert.equal(second.safeMode, true);
  assert.match(second.reason ?? "", /2 starts within 60s/);
});

test("starts spread beyond the window do not trip safe mode", () => {
  const first = recordBoot(defaultState(), 0);
  const later = recordBoot(first.state, SAFE_MODE_WINDOW_MS + 1);
  assert.equal(later.safeMode, false);
});

test("PI_WEB_SAFE_MODE=1 forces safe mode on the first start", () => {
  const boot = recordBoot(defaultState(), 5, { PI_WEB_SAFE_MODE: "1" });
  assert.equal(boot.safeMode, true);
  assert.equal(boot.reason, "PI_WEB_SAFE_MODE=1");
  assert.equal(recordBoot(defaultState(), 5, { PI_WEB_SAFE_MODE: "0" }).safeMode, false);
});

test("a plugin that was activating when the process died is reported as crashed once", () => {
  const marked = markActivating(defaultState(), ["acme.b", "acme.a", "acme.a"]);
  assert.deepEqual(marked.activating, ["acme.a", "acme.b"]);
  const recovered = recoverInterruptedActivation(marked);
  assert.deepEqual(recovered.crashed, ["acme.a", "acme.b"]);
  assert.deepEqual(recovered.state.activating, []);
  assert.deepEqual(recoverInterruptedActivation(recovered.state).crashed, []);
});

test("setPluginState patches one plugin and leaves the others untouched", () => {
  const a = setPluginState(defaultState(), "acme.a", { enabled: true });
  const b = setPluginState(a, "acme.b", { grants: ["routes"] });
  assert.deepEqual(b.plugins["acme.a"], { enabled: true, grants: [] });
  assert.deepEqual(b.plugins["acme.b"], { enabled: false, grants: ["routes"] });
});
