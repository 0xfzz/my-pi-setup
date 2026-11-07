import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverPlugins, MANIFEST_FILE, packageWebPluginDirs, scanRoot } from "../lib/web-plugins/kernel/discovery.ts";

const manifest = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  id,
  name: id,
  version: "1.0.0",
  engines: { piWeb: "^1.0.0", sdk: "^1.0.0" },
  ...extra,
});

function plugin(root: string, dirName: string, id: string, extra: Record<string, unknown> = {}) {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MANIFEST_FILE), manifest(id, extra));
  return dir;
}

function withTree(fn: (base: string) => void) {
  const base = mkdtempSync(join(tmpdir(), "web-plugin-discovery-"));
  try {
    fn(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test("scanRoot finds manifests in immediate subdirectories and ignores everything else", () => {
  withTree((base) => {
    const root = join(base, "web-plugins");
    plugin(root, "zen", "acme.zen");
    mkdirSync(join(root, "no-manifest"));
    writeFileSync(join(root, "stray.ts"), "export {};");
    const scan = scanRoot(root, "repo");
    assert.deepEqual(scan.plugins.map((p) => p.id), ["acme.zen"]);
    assert.equal(scan.plugins[0].source, "repo");
    assert.deepEqual(scan.diagnostics, []);
  });
});

test("a missing root is empty, not an error", () => {
  withTree((base) => {
    const scan = scanRoot(join(base, "absent"), "user");
    assert.deepEqual(scan, { plugins: [], diagnostics: [] });
  });
});

test("a broken manifest is rejected with its path and reason, and does not hide valid siblings", () => {
  withTree((base) => {
    const root = join(base, "web-plugins");
    plugin(root, "good", "acme.good");
    mkdirSync(join(root, "bad"));
    writeFileSync(join(root, "bad", MANIFEST_FILE), "{ nope");
    const scan = scanRoot(root, "user");
    assert.deepEqual(scan.plugins.map((p) => p.id), ["acme.good"]);
    assert.equal(scan.diagnostics.length, 1);
    assert.match(scan.diagnostics[0], /rejected \(user\).*bad[/\\]pi-web-plugin\.json.*not valid JSON/);
  });
});

test("project beats user beats package beats repo for the same id, and losers are listed", () => {
  withTree((base) => {
    const repo = join(base, "repo");
    const user = join(base, "user");
    const project = join(base, "project");
    plugin(repo, "a", "acme.same", { name: "repo copy" });
    plugin(user, "a", "acme.same", { name: "user copy" });
    plugin(project, "a", "acme.same", { name: "project copy" });
    const result = discoverPlugins({ repo, user, project });
    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0].source, "project");
    assert.equal(result.selected[0].manifest.name, "project copy");
    assert.deepEqual(result.shadowed.map((s) => [s.source, s.shadowedBy]), [["user", "project"], ["repo", "project"]]);
    assert.ok(result.diagnostics.some((d) => /shadowed \(repo\): "acme\.same"/.test(d)));
  });
});

test("a package's pi.webPlugins directories are discovered; escaping entries are refused", () => {
  withTree((base) => {
    const pkg = join(base, "pkg");
    plugin(join(pkg, "web"), "zen", "acme.pkg-zen");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pkg", pi: { webPlugins: ["./web/zen", "../outside", "/etc"] } }));
    const listed = packageWebPluginDirs(pkg);
    assert.deepEqual(listed.dirs, [join(pkg, "web/zen")]);
    assert.equal(listed.diagnostics.length, 2);

    const result = discoverPlugins({ packages: [pkg] });
    assert.deepEqual(result.selected.map((p) => [p.id, p.source]), [["acme.pkg-zen", "package"]]);
  });
});

test("a package without pi.webPlugins contributes nothing and no diagnostic", () => {
  withTree((base) => {
    writeFileSync(join(base, "package.json"), JSON.stringify({ name: "cli-only", pi: { extensions: ["./x.ts"] } }));
    assert.deepEqual(packageWebPluginDirs(base), { dirs: [], diagnostics: [] });
  });
});

test("discovery is deterministic: selected plugins are sorted by id", () => {
  withTree((base) => {
    const repo = join(base, "repo");
    plugin(repo, "z", "zeta.one");
    plugin(repo, "a", "alpha.one");
    assert.deepEqual(discoverPlugins({ repo }).selected.map((p) => p.id), ["alpha.one", "zeta.one"]);
  });
});
