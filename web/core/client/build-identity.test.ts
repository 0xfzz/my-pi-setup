// Which client build a page runs, and when it should move to another one.
//
// The failure this pins: `/app.js` has a fixed name, so a page cannot tell from
// a response which bundle it holds. A tab opened before a rebuild keeps running
// the previous plugin code while every new tab runs the current code — two
// versions of the web in one session.

import test from "node:test";
import assert from "node:assert/strict";

import { buildVerdict, ownBuildId } from "./build-identity.ts";

/** The one DOM call the page identity makes: the stamp the server wrote into its HTML. */
function page(content: string | null): Document {
  return {
    querySelector: (selector: string) =>
      selector === 'meta[name="pi-web-build"]' && content !== null
        ? { getAttribute: (name: string) => (name === "content" ? content : null) }
        : null,
  } as unknown as Document;
}

test("the page reads the build id the server stamped into its HTML", () => {
  assert.equal(ownBuildId(page("abc123")), "abc123");
  assert.equal(ownBuildId(page("  ")), null, "a blank stamp is no id");
  assert.equal(ownBuildId(page(null)), null, "a page without the stamp (dev server) has no id");
});

test("a page on the served build stays put", () => {
  assert.equal(buildVerdict("abc123", "abc123", null), "current");
});

test("a page older than the served build reloads onto it", () => {
  assert.equal(buildVerdict("abc123", "def456", null), "stale");
});

test("a page that already reloaded for a build does not reload again", () => {
  // The stamp and the served id cannot converge (a rebuild that keeps landing,
  // or a build that stamps nothing): reloading again would spin the tab.
  assert.equal(buildVerdict("abc123", "def456", "def456"), "reloaded");
  // A newer build than the one already reloaded for is worth another reload.
  assert.equal(buildVerdict("abc123", "ghi789", "def456"), "stale");
});

test("no stamp or nothing served never triggers a reload", () => {
  assert.equal(buildVerdict(null, "abc123", null), "current", "a dev page has no id to compare");
  assert.equal(buildVerdict("abc123", null, null), "current", "a server without a build has nothing to offer");
  assert.equal(buildVerdict("abc123", "", null), "current");
});
