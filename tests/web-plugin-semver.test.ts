import test from "node:test";
import assert from "node:assert/strict";

import { compareVersions, isValidRange, parseVersion, satisfies } from "../lib/web-plugins/kernel/semver.ts";

test("parseVersion accepts strict x.y.z with optional prerelease only", () => {
  assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseVersion("1.0.0-rc.1")?.prerelease, ["rc", "1"]);
  for (const bad of ["1", "1.2", "01.2.3", "1.2.3.4", "v1.2.3", "", "1.2.x"]) {
    assert.equal(parseVersion(bad), undefined, bad);
  }
});

test("compareVersions orders prereleases before their release", () => {
  const v = (s: string) => parseVersion(s)!;
  assert.ok(compareVersions(v("1.0.0-alpha"), v("1.0.0")) < 0);
  assert.ok(compareVersions(v("1.0.0-alpha.2"), v("1.0.0-alpha.10")) < 0);
  assert.ok(compareVersions(v("1.10.0"), v("1.9.9")) > 0);
  assert.equal(compareVersions(v("2.0.0"), v("2.0.0")), 0);
});

test("caret ranges pin the leftmost non-zero component", () => {
  assert.equal(satisfies("1.4.0", "^1.0.0"), true);
  assert.equal(satisfies("2.0.0", "^1.0.0"), false);
  assert.equal(satisfies("0.2.9", "^0.2.0"), true);
  assert.equal(satisfies("0.3.0", "^0.2.0"), false);
  assert.equal(satisfies("0.0.4", "^0.0.3"), false);
  assert.equal(satisfies("1.9.0", "^1"), true);
  assert.equal(satisfies("2.0.0", "^1"), false);
});

test("tilde, comparators, exact, wildcard and combinations", () => {
  assert.equal(satisfies("1.2.9", "~1.2.3"), true);
  assert.equal(satisfies("1.3.0", "~1.2.3"), false);
  assert.equal(satisfies("1.2.0", "~1.2.3"), false);
  assert.equal(satisfies("1.5.0", ">=1.2.0 <2.0.0"), true);
  assert.equal(satisfies("2.0.0", ">=1.2.0 <2.0.0"), false);
  assert.equal(satisfies("1.2.3", "1.2.3"), true);
  assert.equal(satisfies("1.2.4", "=1.2.3"), false);
  assert.equal(satisfies("9.9.9", "*"), true);
  assert.equal(satisfies("3.0.0", "^1.0.0 || ^3.0.0"), true);
  assert.equal(satisfies("2.5.0", "^1.0.0 || ^3.0.0"), false);
});

test("invalid versions and ranges never satisfy and are reported", () => {
  assert.equal(satisfies("nope", "^1.0.0"), false);
  assert.equal(satisfies("1.0.0", ">=banana"), false);
  assert.equal(isValidRange(">=1.0.0 <2.0.0"), true);
  assert.equal(isValidRange("^1.0.0 ||"), false);
  assert.equal(isValidRange("!!"), false);
});
