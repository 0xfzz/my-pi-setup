import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPluginProject, pluginProjectRoots, scaffoldPluginProject } from "../lib/plugin-project.ts";
import { parseManifestText } from "../web/core/plugin-contracts/kernel/manifest.ts";

test("scaffold produces a complete trusted project from an id", () => {
  const result = scaffoldPluginProject("acme.zen", "Zen");
  assert.equal(result.ok, true);
  assert.deepEqual(result.files.map((file) => file.path).sort(), [
    "README.md", "browser.ts", "build.mjs", "contract.ts", "package.json", "pi-web-plugin.json",
  ]);
  const manifestText = result.files.find((file) => file.path === "pi-web-plugin.json")?.content ?? "";
  const parsed = parseManifestText(manifestText);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
  if (parsed.ok) {
    assert.equal(parsed.manifest.trust, "trusted");
    assert.equal(parsed.manifest.main.browser, "./browser.ts");
  }
});

test("the scaffolded project passes its own import-boundary check", () => {
  const result = scaffoldPluginProject("acme.zen");
  assert.deepEqual(checkPluginProject("/plugins/acme", result.files), []);
});

test("check names an import of web/core internals", () => {
  const violations = checkPluginProject("/repo/web/plugins/acme", [{
    path: "browser.ts",
    content: "import { render } from '../../core/client/shell.tsx';\n",
  }]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.line, 1);
  assert.match(violations[0]?.specifier ?? "", /shell\.tsx/);
});

test("the check names a forbidden core import from a project outside the repo", () => {
  const violations = checkPluginProject("/tmp/acme", [{
    path: "browser.ts",
    content: "import { shell } from '../../core/client/shell.tsx';\n",
  }]);
  assert.equal(violations.length, 1);
  assert.match(violations[0]?.specifier ?? "", /shell\.tsx/);
});

test("scaffold, check and build work from an empty folder outside the repo", () => {
  const target = mkdtempSync(join(tmpdir(), "pi-web-plugin-scaffold-"));
  try {
    const root = process.cwd();
    execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings",
      join(root, "scripts", "scaffold-web-plugin.mjs"), "acme.outside", target, "Outside"],
    { cwd: root, encoding: "utf8" });
    const manifest = JSON.parse(readFileSync(join(target, "pi-web-plugin.json"), "utf8")) as { trust: string };
    assert.equal(manifest.trust, "trusted");
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as { scripts: Record<string, string> };
    assert.match(pkg.scripts.build ?? "", /build\.mjs/);
    assert.match(pkg.scripts.check ?? "", /check-web-plugin\.mjs/);
    execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings",
      join(root, "scripts", "check-web-plugin.mjs"), target], { cwd: root, encoding: "utf8" });
    execFileSync(process.execPath, [join(target, "build.mjs")], { cwd: target, encoding: "utf8" });
    assert.ok(readFileSync(join(target, "dist", "browser.js"), "utf8").includes("Outside plugin"));
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("an invalid id never produces files", () => {
  assert.equal(scaffoldPluginProject("Not Valid").ok, false);
});

test("dev plugin roots are explicit absolute paths", () => {
  assert.deepEqual(pluginProjectRoots({ PI_WEB_PLUGIN_ROOTS: "/tmp/a:/tmp/b:relative" }), ["/tmp/a", "/tmp/b"]);
  assert.deepEqual(pluginProjectRoots({}), []);
});
