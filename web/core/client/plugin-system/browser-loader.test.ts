import test from "node:test";
import assert from "node:assert/strict";

import type { WebPluginContext, BrowserModule, BrowserRegistration, BrowserMountHost } from "./browser-loader.ts";
import { loadBrowserHalf, mountBrowserHalf } from "./browser-loader.ts";
import { confirmBrowserGrant, browserGrantDecision } from "../../protocol/browser-runtime.ts";

function ctx(): WebPluginContext {
  return {
    protocol: {} as WebPluginContext["protocol"],
    host: {},
    theme: {},
    logger: { info: () => undefined, warn: () => undefined },
    dom: { text: (value) => ({ nodeValue: value }) as Text, clear: () => undefined },
  };
}

function registration(module: BrowserModule): BrowserRegistration {
  return {
    id: "acme.zen",
    version: "1.0.0",
    hash: "sha256:aaa",
    trust: "trusted",
    sourcePath: "./browser/main.tsx",
    now: 1,
    module,
    grant: confirmBrowserGrant({ id: "acme.zen", version: "1.0.0", hash: "sha256:aaa", sourcePath: "./browser/main.tsx", capabilities: [], now: 1 }),
  };
}

function host() {
  const calls: string[] = [];
  return {
    calls,
    restoreBuiltIn: () => { calls.push("restore"); },
    recordFailure: (id: string) => { calls.push(`failure:${id}`); },
  } satisfies BrowserMountHost & { calls: string[] };
}

const element = {} as HTMLElement;

test("an unconfirmed browser half never mounts", () => {
  const reg = { ...registration({ mount: () => () => undefined }), grant: undefined };
  assert.equal(loadBrowserHalf(reg).ok, false);
});

test("a module's cleanup runs on unmount", () => {
  const calls: string[] = [];
  const mounted = mountBrowserHalf(registration({ mount: () => { calls.push("mount"); return () => { calls.push("cleanup"); }; } }), ctx(), element, host());
  assert.equal(mounted.ok, true);
  if (mounted.ok) mounted.unmount();
  assert.deepEqual(calls, ["mount", "cleanup"]);
});

test("a throwing component restores the built-in and counts a failure", () => {
  const h = host();
  const failed = mountBrowserHalf(registration({ mount: () => { throw new Error("bad render"); } }), ctx(), element, h);
  assert.equal(failed.ok, false);
  assert.deepEqual(h.calls, ["restore", "failure:acme.zen"]);
});

test("a changed hash blocks the browser half before mount", () => {
  const reg = { ...registration({ mount: () => () => undefined }), hash: "sha256:bbb" };
  assert.equal(browserGrantDecision(reg).kind, "revoke");
  assert.equal(mountBrowserHalf(reg, ctx(), element, host()).ok, false);
});
