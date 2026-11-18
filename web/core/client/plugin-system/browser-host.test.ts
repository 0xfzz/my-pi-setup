import test from "node:test";
import assert from "node:assert/strict";

import {
  createBrowserRuntimeHost,
  type BrowserHalfDefinition,
  type BrowserRuntimeStatus,
  verifyBrowserSourceHash,
} from "./browser-host.ts";
import type { BrowserModule, WebPluginContext } from "./browser-loader.ts";
import { BROWSER_GRANTS_KEY, type BrowserGrantStorage } from "./browser-grants.ts";

function storage(): BrowserGrantStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

function context(): Omit<WebPluginContext, "register" | "contributions"> {
  return {
    protocol: {} as WebPluginContext["protocol"],
    host: {},
    theme: {},
    logger: { info: () => undefined, warn: () => undefined },
    dom: { text: (value) => ({ nodeValue: value }) as Text, clear: () => undefined },
  };
}

function definition(module: BrowserModule, overrides: Partial<BrowserHalfDefinition> = {}): BrowserHalfDefinition {
  return {
    id: "acme.zen",
    version: "1.0.0",
    sourcePath: "./browser/index.ts",
    capabilities: ["ui.view"],
    hash: "sha256:aaa",
    module,
    ...overrides,
  };
}

function host(definitions: readonly BrowserHalfDefinition[], options: {
  confirm?: (id: string) => Promise<boolean>;
  status?: BrowserRuntimeStatus;
  store?: BrowserGrantStorage;
} = {}) {
  const store = options.store ?? storage();
  const status: BrowserRuntimeStatus = options.status ?? { safeMode: false, states: {} };
  const runtime = createBrowserRuntimeHost({
    definitions,
    element: {} as HTMLElement,
    context: context(),
    storage: store,
    hash: async (item) => item.hash ?? "sha256:unknown",
    fetchStatus: async () => status,
    confirm: async () => options.confirm?.("acme.zen") ?? false,
    now: () => 42,
    pollMs: 3_600_000,
  });
  return { runtime, status, store };
}

test("a core half is hash-granted and mounted through the runtime", async () => {
  let cleanups = 0;
  const reg = definition({ mount: () => () => { cleanups += 1; } }, { corePlugin: true });
  const { runtime } = host([reg]);
  try {
    await runtime.scan();
    assert.deepEqual(runtime.state().mounted, ["acme.zen"]);
    assert.equal(runtime.state().audit.at(-1)?.kind, "browser-granted");
    assert.equal(runtime.state().contributions.length, 0);
  } finally {
    runtime.stop();
  }
  assert.equal(cleanups, 1, "stopping the runtime unmounts every half");
});

test("a non-core half waits for the operator and audits a refusal", async () => {
  const reg = definition({ mount: () => () => undefined });
  const { runtime } = host([reg]);
  try {
    await runtime.scan();
    assert.deepEqual(runtime.state().mounted, []);
    assert.match(runtime.state().refused["acme.zen"] ?? "", /confirmation/);
    assert.equal(runtime.state().audit.at(-1)?.kind, "browser-refused");
  } finally {
    runtime.stop();
  }
});

test("operator confirmation mounts a trusted half and registers its points", async () => {
  const reg = definition({
    mount: (el, ctx) => {
      ctx.register("commands", "zen.toggle", "ok");
      ctx.register("core.auth.session", "login", "not allowed");
      return () => undefined;
    },
  });
  const { runtime } = host([reg], { confirm: async () => true });
  try {
    await runtime.scan();
    assert.deepEqual(runtime.state().mounted, ["acme.zen"]);
    assert.deepEqual(runtime.state().contributions.map((entry) => entry.key), ["zen.toggle"]);
  } finally {
    runtime.stop();
  }
});

test("safe mode blocks a non-core half even when it has a grant", async () => {
  const reg = definition({ mount: () => () => undefined }, { corePlugin: false });
  const { runtime } = host([reg], { confirm: async () => true, status: { safeMode: true, states: {} } });
  try {
    await runtime.scan();
    assert.deepEqual(runtime.state().mounted, []);
    assert.match(runtime.state().refused["acme.zen"] ?? "", /safe mode/);
  } finally {
    runtime.stop();
  }
});

test("disabling a plugin restores the built-in on the next scan", async () => {
  let restored = 0;
  const status = { safeMode: false, states: {} as Record<string, string> };
  const reg = definition({ mount: () => () => { restored += 1; } }, { corePlugin: true });
  const runtime = createBrowserRuntimeHost({
    definitions: [reg],
    element: {} as HTMLElement,
    context: context(),
    storage: storage(),
    hash: async (item) => item.hash ?? "sha256:unknown",
    fetchStatus: async (): Promise<BrowserRuntimeStatus> => status,
    now: () => 42,
    pollMs: 3_600_000,
  });
  try {
    await runtime.scan();
    status.states["acme.zen"] = "disabled";
    await runtime.scan();
    assert.deepEqual(runtime.state().mounted, []);
    assert.equal(restored, 1);
    assert.match(runtime.state().refused["acme.zen"] ?? "", /disabled/);
  } finally {
    runtime.stop();
  }
});

test("three render failures quarantine the half and revoke its grant", async () => {
  const store = storage();
  const reg = definition({ mount: () => { throw new Error("bad render"); } }, { corePlugin: true });
  const { runtime } = host([reg], { store });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) await runtime.scan();
    assert.deepEqual(runtime.state().quarantined, ["acme.zen"]);
    assert.equal(JSON.parse(store.getItem(BROWSER_GRANTS_KEY) ?? "{}")["acme.zen"], undefined);
    assert.equal(runtime.state().failures["acme.zen"], 3);
  } finally {
    runtime.stop();
  }
});

test("a published hash mismatch refuses a fetched bundle before it is imported", () => {
  assert.doesNotThrow(() => verifyBrowserSourceHash("acme.panel", "sha256:abc", "sha256:abc"));
  assert.doesNotThrow(() => verifyBrowserSourceHash("acme.panel", "sha256:abc"));
  assert.throws(
    () => verifyBrowserSourceHash("acme.panel", "sha256:abc", "sha256:def"),
    /acme\.panel hash changed/,
  );
});

test("a changed hash revokes the stored grant until the operator confirms again", async () => {
  const store = storage();
  const first = definition({ mount: () => () => undefined }, { corePlugin: true });
  const { runtime } = host([first], { store });
  await runtime.scan();
  runtime.stop();
  const changed = { ...first, hash: "sha256:bbb" };
  const next = host([changed], { store, confirm: async () => false });
  try {
    await next.runtime.scan();
    assert.deepEqual(next.runtime.state().mounted, []);
    assert.equal(JSON.parse(store.getItem(BROWSER_GRANTS_KEY) ?? "{}")["acme.zen"], undefined);
  } finally {
    next.runtime.stop();
  }
  const reconfirmed = host([changed], { store, confirm: async () => true });
  try {
    await reconfirmed.runtime.scan();
    assert.deepEqual(reconfirmed.runtime.state().mounted, ["acme.zen"]);
    assert.equal(JSON.parse(store.getItem(BROWSER_GRANTS_KEY) ?? "{}")["acme.zen"].hash, "sha256:bbb");
  } finally {
    reconfirmed.runtime.stop();
  }
});
