import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProviderInScope, scopeCoversProvider } from "../lib/provider/router-scope.ts";

const settings = (doc: unknown): string => {
  const path = join(mkdtempSync(join(tmpdir(), "router-scope-")), "settings.json");
  writeFileSync(path, JSON.stringify(doc));
  return path;
};

test("a curated scope gains the router provider glob and keeps other keys", () => {
  const path = settings({ theme: "dark", enabledModels: ["openai/gpt-5"] });
  assert.equal(ensureProviderInScope(path, "router"), true);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(doc.enabledModels, ["openai/gpt-5", "router/*"]);
  assert.equal(doc.theme, "dark");
  assert.equal(ensureProviderInScope(path, "router"), false, "idempotent");
});

test("no scope, an empty scope or an existing cover is left alone", () => {
  assert.equal(ensureProviderInScope(settings({ theme: "dark" }), "router"), false);
  assert.equal(ensureProviderInScope(settings({ enabledModels: [] }), "router"), false);
  assert.equal(ensureProviderInScope(settings({ enabledModels: ["router/*:high"] }), "router"), false);
  assert.equal(ensureProviderInScope("/nonexistent/settings.json", "router"), false);
  assert.equal(scopeCoversProvider(["*"], "router"), true);
});
