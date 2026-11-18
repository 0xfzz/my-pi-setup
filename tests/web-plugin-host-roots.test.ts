import test from "node:test";
import assert from "node:assert/strict";
import { webPluginDiscoveryRoots } from "../web/core/server/plugin-host.ts";

const dirs = { repo: "/repo", user: "/user", project: "/project" };

test("external plugin roots are opt-in and never replace the built-in roots", () => {
  assert.deepEqual(webPluginDiscoveryRoots({}, dirs), {
    repo: "/repo",
    user: "/user",
    project: "/project",
    packages: [],
  });
  assert.deepEqual(webPluginDiscoveryRoots({ PI_WEB_PLUGIN_ROOTS: "/tmp/a:/tmp/b:relative" }, dirs), {
    repo: "/repo",
    user: "/user",
    project: "/project",
    packages: ["/tmp/a", "/tmp/b"],
  });
});
