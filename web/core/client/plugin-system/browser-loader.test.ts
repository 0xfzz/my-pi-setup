import test from "node:test";
import assert from "node:assert/strict";

import type { WebPluginContext, BrowserModule, BrowserRegistration, BrowserMountHost } from "./browser-loader.ts";
import { loadBrowserHalf, mountBrowserHalf } from "./browser-loader.ts";
import { BROWSER_MAX_BREAKER, confirmBrowserGrant, browserGrantDecision } from "../../protocol/browser-runtime.ts";
import { createBrowserContributionRegistry } from "./browser-contributions.ts";

function ctx(): WebPluginContext {
  return {
    protocol: {} as WebPluginContext["protocol"],
    host: {},
    theme: {},
    logger: { info: () => undefined, warn: () => undefined },
    dom: { text: (value) => ({ nodeValue: value }) as Text, clear: () => undefined },
    contributions: createBrowserContributionRegistry(),
    register: () => true,
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

test("a disabled or quarantined half restores the built-in without mounting", () => {
  let mounts = 0;
  const module = { mount: () => { mounts += 1; return () => undefined; } };
  for (const state of [{ disabled: true }, { quarantined: true }, { failedLoad: true }]) {
    const h = host();
    const result = mountBrowserHalf({ ...registration(module), ...state }, ctx(), element, h);
    assert.equal(result.ok, false);
    assert.deepEqual(h.calls, ["restore"], `built-in restored for ${JSON.stringify(state)}`);
  }
  assert.equal(mounts, 0);
});

test("a half quarantined at the breaker limit cannot mount again", () => {
  const h = host();
  const broken = registration({ mount: () => { throw new Error("bad render"); } });
  for (let attempt = 0; attempt < BROWSER_MAX_BREAKER; attempt += 1) {
    assert.equal(mountBrowserHalf(broken, ctx(), element, h).ok, false);
  }
  assert.equal(h.calls.filter((call) => call === "failure:acme.zen").length, BROWSER_MAX_BREAKER);
  const reg = { ...registration({ mount: () => () => undefined }), quarantined: true };
  assert.equal(mountBrowserHalf(reg, ctx(), element, h).ok, false);
});

test("safe mode restores the built-in for non-core halves only", () => {
  const module = { mount: () => () => undefined };
  const blocked = host();
  assert.equal(mountBrowserHalf({ ...registration(module), safeMode: true }, ctx(), element, blocked).ok, false);
  assert.deepEqual(blocked.calls, ["restore"]);
  const core = host();
  assert.equal(mountBrowserHalf({ ...registration(module), safeMode: true, corePlugin: true }, ctx(), element, core).ok, true);
  assert.deepEqual(core.calls, []);
});

test("a protected registration point is refused and the built-in restored", () => {
  const h = host();
  let mounted = false;
  const reg = { ...registration({ mount: () => { mounted = true; return () => undefined; } }), point: "core.auth.session" };
  const result = mountBrowserHalf(reg, ctx(), element, h);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /protected core/);
  assert.equal(mounted, false);
  assert.deepEqual(h.calls, ["restore"]);
});
