import test from "node:test";
import assert from "node:assert/strict";
import { registerPluginPage, getPluginPage } from "./plugin-system/page-registry.ts";

test("registerPluginPage stores the component under the plugin id", () => {
  const component = () => null;
  registerPluginPage("registry-test-page", component);
  assert.equal(getPluginPage("registry-test-page"), component);
});

test("getPluginPage returns undefined for an unregistered id", () => {
  assert.equal(getPluginPage("never-registered"), undefined);
});

test("registerPluginPage replaces an earlier registration for the same id", () => {
  const first = () => null;
  const second = () => null;
  registerPluginPage("registry-replace-page", first);
  registerPluginPage("registry-replace-page", second);
  assert.equal(getPluginPage("registry-replace-page"), second);
});
