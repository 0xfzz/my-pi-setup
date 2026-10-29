import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalize, expandHome, toResourceSlash } from "../lib/scope/paths.ts";
import {
  initialScopeState,
  loadScopeConfig,
  removeScopeRule,
  scopeRecordFromBranch,
  scopeSnapshot,
} from "../lib/scope/state.ts";
import { SCOPE_RECORD_TYPE, type ScopeState } from "../lib/scope/types.ts";

async function fixture(config?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "scope-state-"));
  if (config !== undefined) {
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(join(dir, ".pi", "scope.json"), JSON.stringify(config));
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("a rules list carries provenance so a rule can be revoked by name", async () => {
  const f = await fixture({
    rules: [
      { action: "bash", resource: "rm *", effect: "deny" },
      { action: "read", resource: "/secrets/*", effect: "deny" },
    ],
  });
  try {
    const file = join(f.dir, ".pi", "scope.json");
    assert.equal(removeScopeRule(file, "bash", "rm *"), true);
    assert.deepEqual(
      JSON.parse(await readFile(file, "utf8")).rules,
      [{ action: "read", resource: "/secrets/*", effect: "deny" }],
      "only the named rule is removed, and the rest of the file survives",
    );
    assert.equal(removeScopeRule(file, "bash", "rm *"), false, "a second removal is a no-op, not an error");
  } finally {
    await f.cleanup();
  }
});

test("a stored ~ rule is revocable by the path the session shows", async () => {
  const f = await fixture({ rules: [{ action: "*", resource: "~/projects/*", effect: "allow" }] });
  try {
    const file = join(f.dir, ".pi", "scope.json");
    // The session reports the expanded path; the file stores `~`. Both must match,
    // or the removal reports success and deletes nothing.
    assert.equal(removeScopeRule(file, "*", `${homedir()}/projects/*`), true);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).rules, []);
  } finally {
    await f.cleanup();
  }
});

test("a session with no config starts at the workspace, read-write", async () => {
  const f = await fixture();
  try {
    const loaded = loadScopeConfig(f.dir);
    assert.deepEqual(loaded.state.roots.map(root => [root.path, root.access]), [[canonicalize(f.dir), "rw"]]);
    assert.deepEqual(loaded.state.defaults, { external: "ask", readExternal: "allow", unknown: "ask" });
    assert.deepEqual(loaded.problems, []);
    assert.deepEqual(loaded.sources, []);
  } finally {
    await f.cleanup();
  }
});

test("project config adds roots relative to the workspace and narrows defaults", async () => {
  const f = await fixture({
    roots: ["../shared", { path: "vendor", access: "ro" }],
    defaults: { external: "deny" },
    rules: [{ action: "read", resource: "vendor/*", effect: "allow" }],
    mcp: { mcp__fs: { pathField: "file" } },
  });
  try {
    const loaded = loadScopeConfig(f.dir);
    const byPath = new Map(loaded.state.roots.map(root => [root.path, root]));
    assert.equal(byPath.get(canonicalize(join(f.dir, "..", "shared")))?.access, "rw");
    assert.equal(byPath.get(canonicalize(join(f.dir, "vendor")))?.access, "ro");
    assert.equal(byPath.get(canonicalize(join(f.dir, "vendor")))?.source, "project");
    assert.equal(loaded.state.defaults.external, "deny");
    assert.equal(loaded.state.defaults.unknown, "ask", "unspecified defaults stay at ask");
    assert.equal(loaded.state.rules.length, 1);
    assert.deepEqual(loaded.mcpPathFields, { mcp__fs: "file" });
    assert.deepEqual(loaded.problems, []);
  } finally {
    await f.cleanup();
  }
});

test("a broken config file is reported instead of silently ignored", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.dir, ".pi"), { recursive: true });
    await writeFile(join(f.dir, ".pi", "scope.json"), "{ not json");
    const loaded = loadScopeConfig(f.dir);
    assert.equal(loaded.problems.length, 1);
    assert.match(loaded.problems[0]!, /scope\.json/);
    assert.equal(loaded.state.roots.length, 1, "the workspace root still exists");
  } finally {
    await f.cleanup();
  }
});

test("yolo is refused from config and must be armed interactively", async () => {
  const f = await fixture({ yolo: { strength: "rw" } });
  try {
    const loaded = loadScopeConfig(f.dir);
    assert.equal(loaded.state.yolo, undefined);
    assert.match(loaded.problems.join("\n"), /arm it interactively/);
  } finally {
    await f.cleanup();
  }
});

test("branch records restore grants but a stored parent-of-workspace grant is refused", async () => {
  const f = await fixture();
  try {
    const parent = canonicalize(join(f.dir, ".."));
    const records = {
      roots: [{ path: canonicalize(join(f.dir, "outside")), access: "ro" as const }, { path: parent, access: "rw" as const }],
      rules: [{ action: "bash", resource: "rm *", effect: "deny" as const }],
    };
    const loaded = loadScopeConfig(f.dir, records);
    const paths = loaded.state.roots.map(root => root.path);
    assert.ok(paths.includes(canonicalize(join(f.dir, "outside"))), "the granted folder is restored");
    assert.ok(!paths.includes(parent), "a grant that contains the workspace is not restored");
    assert.match(loaded.problems.join("\n"), /contains the workspace/);
    assert.equal(loaded.state.rules.some(rule => rule.source === "branch"), true);
  } finally {
    await f.cleanup();
  }
});

test("the last snapshot on the branch wins and unrelated entries are ignored", () => {
  const branch = [
    { type: "message", message: { role: "user" } },
    { type: "custom", customType: SCOPE_RECORD_TYPE, data: { roots: [{ path: "/a", access: "rw" }] } },
    { type: "custom", customType: "something-else", data: { roots: [{ path: "/b", access: "rw" }] } },
    { type: "custom", customType: SCOPE_RECORD_TYPE, data: { roots: [{ path: "/c", access: "ro" }] } },
  ];
  assert.deepEqual(scopeRecordFromBranch(branch)?.roots, [{ path: "/c", access: "ro" }]);
  assert.equal(scopeRecordFromBranch([]), undefined);
  assert.equal(scopeRecordFromBranch(undefined), undefined);
});

test("a snapshot persists session and branch roots, not config or global ones", () => {
  const state: ScopeState = {
    roots: [
      { path: "/work", access: "rw", source: "session" },
      { path: "/cfg", access: "ro", source: "project" },
      { path: "/granted", access: "ro", source: "branch" },
    ],
    rules: [{ action: "bash", resource: "rm *", effect: "deny", source: "project" }],
    defaults: { external: "ask", readExternal: "allow", unknown: "ask" },
    yolo: { strength: "ro", persist: false, since: 1 },
  };
  const snapshot = scopeSnapshot(state);
  assert.deepEqual(snapshot.roots, [
    { path: "/work", access: "rw" },
    { path: "/granted", access: "ro" },
  ]);
  assert.deepEqual(snapshot.rules, [{ action: "bash", resource: "rm *", effect: "deny" }], "provenance is not persisted");
  assert.deepEqual(snapshot.yolo, { strength: "ro" });
  assert.equal(initialScopeState("/work").roots[0]?.path, canonicalize("/work"));
});

test("a rule resource expands ~ the way a root does", async () => {
  const f = await fixture({ rules: [{ action: "read", resource: "~/projects/*", effect: "allow" }] });
  try {
    const loaded = loadScopeConfig(f.dir);
    const expected = toResourceSlash(expandHome("~/projects/*"));
    assert.ok(loaded.state.rules.some(rule => rule.resource === expected), JSON.stringify(loaded.state.rules));
  } finally {
    await f.cleanup();
  }
});

test("a wildcard root is kept when its prefix exists and refused when it would re-expose home", async () => {
  const f = await fixture();
  try {
    const areas = join(f.dir, "areas");
    await mkdir(areas, { recursive: true });
    await mkdir(join(f.dir, ".pi"), { recursive: true });
    await writeFile(join(f.dir, ".pi", "scope.json"), JSON.stringify({ roots: ["./areas/*"] }));
    const kept = loadScopeConfig(f.dir);
    assert.ok(kept.state.roots.some(root => root.path === `${canonicalize(areas)}/*`), JSON.stringify(kept.state.roots));
  } finally {
    await f.cleanup();
  }

  const home = await fixture({ roots: [`${homedir()}/*`] });
  try {
    const refused = loadScopeConfig(home.dir);
    assert.equal(refused.state.roots.length, 1, "only the workspace root survives");
    assert.match(refused.problems.join("\n"), /Ignoring root/);
  } finally {
    await home.cleanup();
  }
});
