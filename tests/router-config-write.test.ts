import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readRouteDoc, removeRoute, routeSources, routerConfigPaths, ROUTE_FILE, saveRoute,
} from "../lib/router-config.ts";
import type { RouteConfig } from "../lib/model-routes.ts";

async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-router-config-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const auto: RouteConfig = { name: "auto", targets: [{ model: "a/one" }, { model: "a/two" }] };
const cheap: RouteConfig = {
  name: "cheap",
  label: "Cheap",
  description: "pennies",
  targets: [{ model: "a/one", pool: "ag", thinking: "low" }],
  method: "cheapest",
  when: "quota",
  sticky: false,
  pool: "ag",
};

// ── Reading ──────────────────────────────────────────────────────────────────

test("a missing file reads as an empty document, not an error", async () => fixture(async (dir) => {
  const doc = readRouteDoc(join(dir, ROUTE_FILE), "global");
  assert.deepEqual(doc.routes, []);
  assert.deepEqual(doc.errors, []);
  assert.deepEqual(doc.raw, {});
}));

test("a broken file is reported for reading and keeps its raw document untouched on disk", async () => fixture(async (dir) => {
  const path = join(dir, ROUTE_FILE);
  await writeFile(path, "{not json");
  const doc = readRouteDoc(path, "global");
  assert.equal(doc.routes.length, 0);
  assert.match(doc.errors[0]!, /not valid JSON|Unexpected token|Expected property/i);
  await assert.rejects(
    async () => saveRoute(path, auto),
    /refusing to write .*not valid JSON/,
    "a writer must never replace a file it could not parse",
  );
  assert.equal(await readFile(path, "utf8"), "{not json", "the broken file is left exactly as it was");
}));

test("routeSources reports the effective source per route and which global routes are shadowed", async () => fixture(async (dir) => {
  const { global, project } = routerConfigPaths(dir, join(dir, "project"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "project", ".pi"), { recursive: true });
  await writeFile(global, JSON.stringify({ routes: [
    { name: "auto", targets: ["a/one"] },
    { name: "shared", targets: ["a/one"] },
  ] }));
  await writeFile(project, JSON.stringify({ routes: [{ name: "shared", targets: ["b/two"] }] }));

  const sources = routeSources(global, project);
  assert.deepEqual(sources.routes.map((entry) => `${entry.route.name}:${entry.source}`), ["auto:global", "shared:project"]);
  assert.deepEqual(sources.shadowed.map((entry) => entry.route.name), ["shared"], "the global copy is shadowed, so deleting the override restores it");
  assert.equal(sources.routes[1]!.route.targets[0]!.model, "b/two");
  assert.deepEqual(sources.errors, []);
}));

test("routerConfigPaths puts the global file in the agent dir and the project file under .pi", () => {
  const paths = routerConfigPaths("/agent", "/work");
  assert.equal(paths.global, "/agent/account-router.json");
  assert.equal(paths.project, "/work/.pi/account-router.json");
});

// ── Writing: preservation ────────────────────────────────────────────────────

test("saving a route preserves pools, provider and unknown keys", async () => fixture(async (dir) => {
  const path = join(dir, ROUTE_FILE);
  const before = {
    provider: "router",
    unknownTop: { keep: true },
    pools: { ag: { provider: "antigravity", strategy: "round-robin" } },
    routes: [{ name: "keep", targets: ["z/zed"], note: "hand written" }],
  };
  await writeFile(path, JSON.stringify(before));

  saveRoute(path, auto);

  const after = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(after.pools, before.pools, "pools are the user's accounts; they must survive every route edit");
  assert.equal(after.provider, "router");
  assert.deepEqual(after.unknownTop, { keep: true });
  assert.deepEqual(after.routes[0], before.routes[0], "an untouched route keeps its own unknown keys");
  assert.deepEqual(after.routes[1], { name: "auto", targets: ["a/one", "a/two"] });
}));

test("saving replaces a route in place and leaves the order of the file alone", async () => fixture(async (dir) => {
  const path = join(dir, ROUTE_FILE);
  await writeFile(path, JSON.stringify({ routes: [
    { name: "first", targets: ["a/one"] },
    { name: "auto", targets: ["a/old"] },
    { name: "last", targets: ["a/one"] },
  ] }));

  saveRoute(path, auto);

  const after = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(after.routes.map((route: RouteConfig) => route.name), ["first", "auto", "last"]);
  assert.deepEqual(after.routes[1].targets, ["a/one", "a/two"]);
}));

test("a route's method, when, sticky, pool and per-target thinking round-trip", async () => fixture(async (dir) => {
  const path = join(dir, ROUTE_FILE);
  saveRoute(path, cheap);
  const after = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(after.routes[0], {
    name: "cheap",
    label: "Cheap",
    description: "pennies",
    targets: [{ model: "a/one", pool: "ag", thinking: "low" }],
    sticky: false,
    pool: "ag",
    method: "cheapest",
    when: "quota",
  });
  const reread = readRouteDoc(path, "project");
  assert.deepEqual(reread.errors, []);
  assert.deepEqual(reread.routes[0]!.route, cheap);
}));

test("a route that keeps the defaults is written in the smallest form", async () => fixture(async (dir) => {
  const path = join(dir, ROUTE_FILE);
  saveRoute(path, { name: "plain", targets: [{ model: "a/one" }], method: "priority", when: "turn" });
  const text = await readFile(path, "utf8");
  assert.doesNotMatch(text, /"method"/, "the default method is omitted, not spelled out");
  assert.doesNotMatch(text, /"when"/, "the default trigger is omitted, not spelled out");
  assert.match(text, /"targets": \[\s*"a\/one"\s*\]/, "a target with no pool or thinking stays a plain string");
}));

test("saving creates missing directories and a new file is owner-only", async () => fixture(async (dir) => {
  const path = join(dir, "nested", "deeper", ROUTE_FILE);
  saveRoute(path, auto);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(readRouteDoc(path, "global").routes.map((entry) => entry.route.name), ["auto"]);
}));

test("an existing file keeps its own permissions", async () => fixture(async (dir) => {
  const path = join(dir, ROUTE_FILE);
  await writeFile(path, JSON.stringify({ routes: [] }), { mode: 0o644 });
  await (await import("node:fs/promises")).chmod(path, 0o644);
  saveRoute(path, auto);
  assert.equal((await stat(path)).mode & 0o777, 0o644, "the writer does not silently tighten a file the user owns");
}));

test("the write is atomic: no temp file survives a save", async () => fixture(async (dir) => {
  const path = join(dir, ROUTE_FILE);
  saveRoute(path, auto);
  saveRoute(path, { ...auto, targets: [{ model: "a/three" }] });
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
}));

// ── Writing: refusal ─────────────────────────────────────────────────────────

test("an invalid route is refused before it reaches the file", async () => fixture(async (dir) => {
  const path = join(dir, ROUTE_FILE);
  await writeFile(path, JSON.stringify({ routes: [{ name: "keep", targets: ["a/one"] }] }));
  await assert.rejects(async () => saveRoute(path, { name: "bad name", targets: [{ model: "a/one" }] }), /"name" may only contain/);
  await assert.rejects(async () => saveRoute(path, { name: "empty", targets: [] }), /at least one target/);
  await assert.rejects(async () => saveRoute(path, { name: "notref", targets: [{ model: "nope" }] }), /"provider\/model"/);
  const after = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(after.routes.map((route: RouteConfig) => route.name), ["keep"], "a refused save changes nothing");
}));

test("refusing to write a non-object document names what it found", async () => fixture(async (dir) => {
  const path = join(dir, ROUTE_FILE);
  await writeFile(path, "[]");
  await assert.rejects(async () => saveRoute(path, auto), /expected a JSON object, found an array/);
}));

// ── Removing ─────────────────────────────────────────────────────────────────

test("removing a route drops only that route and keeps everything else", async () => fixture(async (dir) => {
  const path = join(dir, ROUTE_FILE);
  await writeFile(path, JSON.stringify({
    pools: { ag: { provider: "antigravity" } },
    routes: [{ name: "auto", targets: ["a/one"] }, { name: "cheap", targets: ["a/one"] }],
  }));

  assert.equal(removeRoute(path, "auto"), true);
  const after = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(after.routes.map((route: RouteConfig) => route.name), ["cheap"]);
  assert.deepEqual(after.pools, { ag: { provider: "antigravity" } }, "pools survive a route deletion");
  assert.equal(removeRoute(path, "auto"), false, "a second removal is a reported no-op, not a rewrite");
  assert.equal(removeRoute(join(dir, "missing.json"), "auto"), false, "a missing file is a no-op, not a created file");
}));
