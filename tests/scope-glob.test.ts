import assert from "node:assert/strict";
import { test } from "node:test";
import { globMatch, resolveRule } from "../lib/scope/glob.ts";
import type { ScopeRule } from "../lib/scope/types.ts";

const rule = (action: string, resource: string, effect: "allow" | "ask" | "deny"): ScopeRule => ({ action, resource, effect });

test("glob wildcards match like opencode: * spans separators, ? is one character", () => {
  assert.equal(globMatch("*", "src/deep/file.ts"), true);
  assert.equal(globMatch("*.env", "config/.env"), true);
  assert.equal(globMatch("src/*", "src/a.mjs"), true);
  assert.equal(globMatch("src/*", "src/deep/a.mjs"), true);
  assert.equal(globMatch("src/?", "src/a"), true);
  assert.equal(globMatch("src/?", "src/ab"), false);
  assert.equal(globMatch("src/?", "src/a/b"), false);
});

test("glob matching is literal for regex metacharacters", () => {
  assert.equal(globMatch("src/a.mjs", "src/axmjs"), false, "the dot must not behave like a regex dot");
  assert.equal(globMatch("a+b", "a+b"), true);
  assert.equal(globMatch("(x)", "(x)"), true);
});

test("rule resolution is last-match-wins so a catch-all can be overridden", () => {
  const rules = [rule("*", "*", "allow"), rule("bash", "rm *", "deny"), rule("bash", "rm -rf /tmp/scratch*", "allow")];
  assert.equal(resolveRule(rules, "read", "src/a.ts")?.effect, "allow");
  assert.equal(resolveRule(rules, "bash", "rm -rf build")?.effect, "deny");
  assert.equal(
    resolveRule(rules, "bash", "rm -rf /tmp/scratch-1")?.effect,
    "allow",
    "a later exception must win over the earlier deny",
  );
});

test("an empty rule set has no opinion instead of defaulting to allow", () => {
  assert.equal(resolveRule([], "read", "src/a.ts"), undefined);
  assert.equal(resolveRule([rule("bash", "*", "deny")], "read", "src/a.ts"), undefined);
});
