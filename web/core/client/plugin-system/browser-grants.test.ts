import test from "node:test";
import assert from "node:assert/strict";

import { createBrowserGrantStore } from "./browser-grants.ts";
import { browserGrantPromptText } from "../../protocol/browser-runtime.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

const info = {
  id: "acme.zen",
  version: "1.0.0",
  sourcePath: "./browser/main.tsx",
  hash: "sha256:aaa",
  capabilities: ["ui.view"],
};

test("a confirmed grant survives a new store instance and carries audit detail", () => {
  const storage = memoryStorage();
  const store = createBrowserGrantStore(storage);
  store.commit({ kind: "confirm", id: info.id, info }, 10);
  const reloaded = createBrowserGrantStore(storage);
  assert.equal(reloaded.grants()[info.id]?.hash, info.hash);
  assert.equal(reloaded.audit().at(-1)?.kind, "browser-granted");
  assert.match(reloaded.audit().at(-1)?.detail ?? "", /sha256:aaa/);
});

test("a changed-hash revoke removes the stored grant and audits the reason", () => {
  const storage = memoryStorage();
  const store = createBrowserGrantStore(storage);
  store.commit({ kind: "confirm", id: info.id, info }, 10);
  store.commit({ kind: "revoke", id: info.id, reason: "browser module hash changed" }, 11);
  assert.equal(store.grants()[info.id], undefined);
  assert.equal(store.audit().at(-1)?.kind, "browser-revoked");
});

test("corrupt grant storage never blocks the browser", () => {
  const storage = memoryStorage();
  storage.setItem("pi-web.browser-grants.v1", "not json");
  const store = createBrowserGrantStore(storage);
  assert.deepEqual(store.grants(), {});
  assert.deepEqual(store.audit(), []);
});

test("the confirmation text is the text shown in the operator dialog", () => {
  assert.match(browserGrantPromptText(info), /Capabilities: ui\.view/);
});
