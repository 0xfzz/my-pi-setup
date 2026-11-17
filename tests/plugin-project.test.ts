import test from "node:test";
import assert from "node:assert/strict";
import { checkPluginProject, pluginProjectRoots, scaffoldPluginProject } from "../lib/plugin-project.ts";
import { parseManifestText } from "../web/core/plugin-contracts/kernel/manifest.ts";

test("scaffold produces a complete trusted project from an id", () => {
  const result = scaffoldPluginProject("acme.zen", "Zen");
  assert.equal(result.ok, true);
  assert.deepEqual(result.files.map((file) => file.path).sort(), [
    "README.md", "browser.ts", "contract.ts", "package.json", "pi-web-plugin.json",
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

test("an invalid id never produces files", () => {
  assert.equal(scaffoldPluginProject("Not Valid").ok, false);
});

test("dev plugin roots are explicit absolute paths", () => {
  assert.deepEqual(pluginProjectRoots({ PI_WEB_PLUGIN_ROOTS: "/tmp/a:/tmp/b:relative" }), ["/tmp/a", "/tmp/b"]);
  assert.deepEqual(pluginProjectRoots({}), []);
});
