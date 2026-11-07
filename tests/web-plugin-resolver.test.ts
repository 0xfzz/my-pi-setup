import test from "node:test";
import assert from "node:assert/strict";

import {
  deactivationOrder,
  requiredDependents,
  resolvePlugins,
  type ResolverInput,
} from "../lib/web-plugins/kernel/resolver.ts";

const p = (
  id: string,
  version = "1.0.0",
  dependsOn: Record<string, string> = {},
  optionalDependsOn: Record<string, string> = {},
): ResolverInput => ({ id, version, dependsOn, optionalDependsOn });

test("dependencies are ordered before dependents, ties break on id", () => {
  const res = resolvePlugins([
    p("acme.zen", "1.2.0", { "core.messages": "^1.0.0" }),
    p("core.messages", "1.0.0"),
    p("b.solo"),
    p("a.solo"),
  ]);
  assert.deepEqual(res.unresolved, {});
  assert.deepEqual(res.ordered, ["a.solo", "b.solo", "core.messages", "acme.zen"]);
  assert.deepEqual(deactivationOrder(res.ordered), ["acme.zen", "core.messages", "b.solo", "a.solo"]);
});

test("a missing or incompatible dependency is unresolved and names the pair", () => {
  const missing = resolvePlugins([p("acme.zen", "1.0.0", { "core.messages": "^1.0.0" })]);
  assert.deepEqual(missing.ordered, []);
  assert.match(missing.unresolved["acme.zen"], /missing dependency "core.messages" \(requires \^1\.0\.0\)/);

  const wrong = resolvePlugins([p("core.messages", "2.0.0"), p("acme.zen", "1.0.0", { "core.messages": "^1.0.0" })]);
  assert.match(wrong.unresolved["acme.zen"], /"acme\.zen" requires "core\.messages" \^1\.0\.0, found 2\.0\.0/);
  assert.deepEqual(wrong.ordered, ["core.messages"]);
});

test("a plugin that depends on an unresolved plugin is unresolved transitively", () => {
  const res = resolvePlugins([
    p("core.base", "1.0.0", { "missing.lib": "^1.0.0" }),
    p("acme.mid", "1.0.0", { "core.base": "^1.0.0" }),
    p("acme.top", "1.0.0", { "acme.mid": "^1.0.0" }),
    p("acme.free"),
  ]);
  assert.deepEqual(res.ordered, ["acme.free"]);
  assert.equal(res.unresolved["acme.mid"], 'depends on unresolved plugin "core.base"');
  assert.equal(res.unresolved["acme.top"], 'depends on unresolved plugin "acme.mid"');
});

test("a dependency cycle is unresolved and the reason names the cycle (AC1)", () => {
  const res = resolvePlugins([
    p("acme.a", "1.0.0", { "acme.b": "^1.0.0" }),
    p("acme.b", "1.0.0", { "acme.c": "^1.0.0" }),
    p("acme.c", "1.0.0", { "acme.a": "^1.0.0" }),
    p("acme.tail", "1.0.0", { "acme.a": "^1.0.0" }),
    p("acme.ok"),
  ]);
  assert.deepEqual(res.ordered, ["acme.ok"]);
  assert.equal(res.unresolved["acme.a"], "dependency cycle: acme.a -> acme.b -> acme.c -> acme.a");
  assert.equal(res.unresolved["acme.b"], "dependency cycle: acme.b -> acme.c -> acme.a -> acme.b");
  assert.equal(res.unresolved["acme.tail"], "depends on a dependency cycle");
});

test("optional dependencies may be absent but must be compatible when present", () => {
  const absent = resolvePlugins([p("acme.zen", "1.0.0", {}, { "acme.metrics": "^1.0.0" })]);
  assert.deepEqual(absent.unresolved, {});
  assert.deepEqual(absent.ordered, ["acme.zen"]);

  const present = resolvePlugins([p("acme.metrics", "2.0.0"), p("acme.zen", "1.0.0", {}, { "acme.metrics": "^1.0.0" })]);
  assert.match(present.unresolved["acme.zen"], /optionally requires "acme\.metrics" \^1\.0\.0, found 2\.0\.0/);
});

test("optional edges still order the plugin after its optional dependency when it is present", () => {
  const res = resolvePlugins([p("acme.zen", "1.0.0", {}, { "acme.metrics": "^1.0.0" }), p("acme.metrics", "1.1.0")]);
  assert.deepEqual(res.ordered, ["acme.metrics", "acme.zen"]);
});

test("duplicate ids in the input are reported, not silently merged", () => {
  const res = resolvePlugins([p("acme.zen"), p("acme.zen", "2.0.0")]);
  assert.equal(res.unresolved["acme.zen"], 'duplicate plugin id "acme.zen"');
});

test("requiredDependents lists direct required dependents only", () => {
  const candidates = [
    p("core.messages"),
    p("acme.zen", "1.0.0", { "core.messages": "^1.0.0" }),
    p("acme.opt", "1.0.0", {}, { "core.messages": "^1.0.0" }),
  ];
  assert.deepEqual(requiredDependents("core.messages", candidates), ["acme.zen"]);
});
