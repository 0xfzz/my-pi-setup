// Regression: the peer ranges in package.json were "*", so a Pi upgrade silently
// changed what this package ran against. Pi 1.5.0 was measured to break the
// vendored Antigravity import of `Type` and the Plan-mode tool list. The
// peer range is now the verified 1.4.x line, and this test fails if the Pi
// host the suite actually loads drifts outside it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
const pkg = readJson("package.json");
const installed = (name: string) => readJson(join("node_modules", name, "package.json")).version as string;

test("declared Pi peer range is the verified 1.4.x line", () => {
  assert.equal(pkg.peerDependencies["@earendil-works/pi-coding-agent"], "~1.4.0");
  assert.equal(pkg.peerDependencies["@earendil-works/pi-tui"], "~1.4.0");
});

test("the installed Pi host is inside the declared peer range", () => {
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
    assert.match(installed(name), /^1\.4\.\d+$/, `${name} must be 1.4.x, got ${installed(name)}`);
  }
});

test("the dev pin matches the installed Pi host, so tests run what the range promises", () => {
  assert.equal(pkg.devDependencies["@earendil-works/pi-coding-agent"], installed("@earendil-works/pi-coding-agent"));
  assert.equal(pkg.devDependencies["@earendil-works/pi-tui"], installed("@earendil-works/pi-tui"));
});
