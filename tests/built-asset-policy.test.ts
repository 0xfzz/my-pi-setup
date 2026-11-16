import test from "node:test";
import assert from "node:assert/strict";
import { assetPathname, BUILT_ASSET_OPTIONS, isStaticMiss } from "../lib/built-asset-policy.ts";

test("built assets do not acquire cache validators, range responses or directory redirects", () => {
  assert.equal(BUILT_ASSET_OPTIONS.etag, false);
  assert.equal(BUILT_ASSET_OPTIONS.lastModified, false);
  assert.equal(BUILT_ASSET_OPTIONS.acceptRanges, false);
  assert.equal(BUILT_ASSET_OPTIONS.cacheControl, false);
  assert.equal(BUILT_ASSET_OPTIONS.redirect, false);
  assert.equal(BUILT_ASSET_OPTIONS.dotfiles, "deny");
});

test("asset path policy strips queries and decodes once without normalizing traversal", () => {
  for (const [url, expected] of [["/", "/"], ["/assets/app.js?cache=1", "/assets/app.js"], ["/a%20b.css", "/a b.css"]]) {
    assert.equal(assetPathname(url!), expected);
  }
  for (const path of ["/%zz", "/.env", "/assets/%2e%2e/index.html", "/assets/..%2fsecret.js", "/assets/%5csecret.js", "/%00.txt"]) {
    assert.equal(assetPathname(path), null, path);
  }
});

test("static miss classification accepts only structured 4xx failures", () => {
  for (const statusCode of [400, 403, 404, 416, 499]) {
    assert.equal(isStaticMiss({ statusCode }), true);
  }
  for (const error of [null, undefined, "404", 404, {}, { statusCode: "404" }, { statusCode: 399 }, { statusCode: 500 }, { statusCode: NaN }]) {
    assert.equal(isStaticMiss(error), false);
  }
});
