import test from "node:test";
import assert from "node:assert/strict";

import {
  createBrowserContributionRegistry,
  type BrowserContribution,
} from "./browser-contributions.ts";
import { BROWSER_EXTENSION_POINTS } from "../../protocol/browser-runtime.ts";

function contribution(point: string, key = "main"): BrowserContribution {
  return { point, key, value: { label: key } };
}

test("every declared browser extension point registers", () => {
  const registry = createBrowserContributionRegistry();
  for (const point of BROWSER_EXTENSION_POINTS) {
    const result = registry.register("acme.zen", contribution(point));
    assert.equal(result.ok, true, `${point} must register`);
  }
  assert.equal(registry.list().length, BROWSER_EXTENSION_POINTS.length);
});

test("protected core points are refused on the real registration path", () => {
  const registry = createBrowserContributionRegistry();
  const result = registry.register("acme.zen", contribution("core.auth.session"));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /protected core/);
  assert.deepEqual(registry.list(), []);
});

test("unknown extension points are refused", () => {
  const registry = createBrowserContributionRegistry();
  const result = registry.register("acme.zen", contribution("core.unknown.thing"));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /unknown extension point/);
});

test("a plugin's contributions are removed together on unmount", () => {
  const registry = createBrowserContributionRegistry();
  registry.register("acme.zen", contribution("commands", "zen.toggle"));
  registry.register("acme.zen", contribution("themes", "zen-dark"));
  registry.register("other.plugin", contribution("commands", "other"));
  const removed = registry.unregisterPlugin("acme.zen");
  assert.equal(removed, 2);
  assert.deepEqual(registry.list("commands").map((entry) => entry.key), ["other"]);
});

test("subscribers see registration and removal", () => {
  const registry = createBrowserContributionRegistry();
  const seen: string[] = [];
  const stop = registry.subscribe(() => seen.push("change"));
  registry.register("acme.zen", contribution("keys", "alt+z"));
  registry.unregisterPlugin("acme.zen");
  stop();
  registry.register("acme.zen", contribution("keys", "alt+y"));
  assert.deepEqual(seen, ["change", "change"]);
});
