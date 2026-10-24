import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ProviderConfig } from "../lib/provider-config.ts";
import { DiscoveryError, discoveryValue, discoveryAuth, modelsEndpoint, discoverModels, discoverModelDetails, type DiscoveredModel } from "../lib/provider-discovery.ts";

const config = (api = "openai-completions", baseUrl = "https://discovery.invalid/v1"): ProviderConfig => ({ api, baseUrl });
const json = (payload: unknown) => new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
type Request = { url: URL; init: RequestInit; headers: Headers };

function fakeFetch(reply: (request: Request, index: number) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const request = {
      url: new URL(input instanceof globalThis.Request ? input.url : String(input)),
      init,
      headers: new Headers(init.headers),
    };
    requests.push(request);
    return reply(request, requests.length - 1);
  };
  return { fetch: fetcher, requests };
}

function registryFixture(options: {
  registered?: boolean;
  source?: string;
  configured?: boolean;
  oauth?: boolean;
  resolved?: { auth: { apiKey?: string; headers?: Record<string, string>; baseUrl?: string } } | undefined;
} = {}) {
  const calls: string[] = [];
  const registry = {
    getRegisteredProviderIds: () => { calls.push("registered"); return options.registered ? ["fixture"] : []; },
    getProviderAuthStatus: () => { calls.push("status"); return { source: options.source, configured: options.configured ?? false }; },
    getProvider: () => { calls.push("provider"); return { auth: { oauth: options.oauth ? {} : undefined } }; },
    getProviderAuth: async () => { calls.push("resolve"); return options.resolved; },
  } as unknown as ModelRegistry;
  return { registry, calls };
}

function manual(error: unknown): boolean {
  assert.ok(error instanceof DiscoveryError);
  assert.match(error.message, /manual|own model discovery|Log in|environment variable/i);
  return true;
}

async function localServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("discoveryValue interpolates only explicit fixture env, preserving literal escapes", () => {
  const env = { TOKEN: "fixture-token", _EXTRA2: "tail", EMPTY: "" };
  assert.equal(discoveryValue("literal", env), "literal");
  assert.equal(discoveryValue("Bearer ${TOKEN}/$TOKEN/${_EXTRA2}", env), "Bearer fixture-token/fixture-token/tail");
  assert.equal(discoveryValue("$$TOKEN $${TOKEN} $!command $$$TOKEN", env), "$TOKEN ${TOKEN} !command $fixture-token");
  assert.equal(discoveryValue("$9 ${not-valid} trailing$", env), "$9 ${not-valid} trailing$");
  assert.equal(discoveryValue("", env), "");
  for (const value of ["$MISSING", "${MISSING}", "$EMPTY"]) {
    assert.throws(() => discoveryValue(value, env), error => {
      assert.ok(error instanceof DiscoveryError);
      assert.match(error.message, /environment variable is unset/);
      assert.doesNotMatch(error.message, /fixture-token/);
      return true;
    });
  }
});

test("discoveryValue rejects commands and unsupported values without executing anything", () => {
  for (const value of ["!printf must-not-run", "!", undefined, null, 12, true, {}, []]) {
    assert.throws(() => discoveryValue(value, {}), manual);
  }
});

test("discoveryAuth resolves literal/env config without consulting native credentials", async () => {
  const key = "PI_DISCOVERY_TEST_FIXTURE_7A4C";
  const before = process.env[key];
  process.env[key] = "fixture-env-value";
  try {
    const h = registryFixture({ source: "config", configured: true });
    assert.deepEqual(await discoveryAuth(h.registry, "fixture", {
      ...config(), apiKey: `$${key}`, headers: { "X-Fixture": `prefix ${"${"}${key}}`, "X-Literal": "$$literal $!safe" },
    }), { apiKey: "fixture-env-value", headers: { "X-Fixture": "prefix fixture-env-value", "X-Literal": "$literal !safe" } });
    assert.deepEqual(h.calls, ["registered", "status"]);
    const anonymous = registryFixture();
    assert.deepEqual(await discoveryAuth(anonymous.registry, "fixture", config()), { apiKey: undefined, headers: {} });
    assert.ok(!anonymous.calls.includes("resolve"));
  } finally {
    if (before === undefined) delete process.env[key]; else process.env[key] = before;
  }
});

for (const source of ["stored", "runtime"]) {
  test(`discoveryAuth gives native ${source} auth precedence and merges explicit headers last`, async () => {
    const h = registryFixture({ source, configured: true, resolved: { auth: {
      apiKey: `fixture-${source}-key`, baseUrl: "https://discovery.invalid/v1/",
      headers: { "X-Native": "native", "X-Override": "old" },
    } } });
    assert.deepEqual(await discoveryAuth(h.registry, "fixture", {
      ...config(), apiKey: "$INTENTIONALLY_UNSET_DISCOVERY_KEY", headers: { "X-Override": "new" },
    }), { apiKey: `fixture-${source}-key`, headers: { "X-Native": "native", "X-Override": "new" } });
    assert.deepEqual(h.calls, ["registered", "status", "provider", "resolve"]);
  });
}

test("discoveryAuth resolves configured native auth when no config key exists", async () => {
  const h = registryFixture({ configured: true, resolved: { auth: { headers: { Authorization: "Bearer fixture-native" } } } });
  assert.deepEqual(await discoveryAuth(h.registry, "fixture", config()), {
    apiKey: undefined, headers: { Authorization: "Bearer fixture-native" },
  });
  assert.ok(h.calls.includes("resolve"));
});

test("discoveryAuth rejects extension-owned and OAuth providers before resolving or refreshing auth", async () => {
  const extension = registryFixture({ registered: true, source: "stored", oauth: true });
  await assert.rejects(discoveryAuth(extension.registry, "fixture", { ...config(), apiKey: "!must-not-run" }), manual);
  assert.deepEqual(extension.calls, ["registered"]);
  for (const source of ["stored", "runtime"]) {
    const oauth = registryFixture({ source, configured: true, oauth: true });
    await assert.rejects(discoveryAuth(oauth.registry, "fixture", config()), manual);
    assert.deepEqual(oauth.calls, ["registered", "status", "provider"]);
  }
});

test("discoveryAuth validates all config commands/headers before resolving stored authentication", async () => {
  for (const invalid of [
    { apiKey: "!printf must-not-run" },
    { apiKey: "$!literal", headers: { "X-Command": "!printf must-not-run" } },
    { headers: { "X-Unsupported": 123 } },
    { headers: [] }, { headers: null }, { headers: "invalid" },
  ]) {
    const h = registryFixture({ source: "stored", configured: true });
    await assert.rejects(discoveryAuth(h.registry, "fixture", { ...config(), ...invalid }), manual);
    assert.deepEqual(h.calls, ["registered"]);
  }
});

test("discoveryAuth reports missing native auth and refuses auth for a different endpoint", async () => {
  const missing = registryFixture({ source: "stored", configured: true });
  await assert.rejects(discoveryAuth(missing.registry, "fixture", config()), manual);
  for (const baseUrl of ["https://elsewhere.invalid/v1", "https://discovery.invalid/v2"]) {
    const h = registryFixture({ source: "runtime", resolved: { auth: { apiKey: "fixture-secret", baseUrl } } });
    await assert.rejects(discoveryAuth(h.registry, "fixture", config()), error => {
      assert.ok(manual(error));
      assert.doesNotMatch((error as Error).message, /fixture-secret|elsewhere/);
      return true;
    });
  }
});

for (const api of ["openai-completions", "openai-responses"]) {
  test(`${api} uses the configured models URL, GET and Bearer auth`, async () => {
    const h = fakeFetch(() => json({ data: [{ id: "fixture-model" }] }));
    assert.equal(modelsEndpoint(config(api)).href, "https://discovery.invalid/v1/models");
    assert.equal(modelsEndpoint(config(api, "https://discovery.invalid/")).href, "https://discovery.invalid/models");
    assert.deepEqual(await discoverModels(config(api), { fetch: h.fetch, apiKey: "fixture-key" }), ["fixture-model"]);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url.href, "https://discovery.invalid/v1/models");
    assert.equal(h.requests[0].init.method, "GET");
    assert.equal(h.requests[0].init.body, undefined);
    assert.equal(h.requests[0].headers.get("authorization"), "Bearer fixture-key");
    assert.equal(h.requests[0].headers.get("accept"), "application/json");
    assert.equal(h.requests[0].init.redirect, "error");
    assert.ok(h.requests[0].init.signal instanceof AbortSignal);
  });
}

for (const baseUrl of ["https://discovery.invalid", "https://discovery.invalid/", "https://discovery.invalid/v1/"]) {
  test(`Anthropic builds /v1/models and uses version/x-api-key headers for ${baseUrl}`, async () => {
    const cfg = config("anthropic-messages", baseUrl);
    assert.equal(modelsEndpoint(cfg).href, "https://discovery.invalid/v1/models");
    const h = fakeFetch(() => json({ data: [{ id: "claude-fixture" }] }));
    await discoverModels(cfg, { fetch: h.fetch, apiKey: "fixture-anthropic" });
    assert.equal(h.requests[0].headers.get("x-api-key"), "fixture-anthropic");
    assert.equal(h.requests[0].headers.get("anthropic-version"), "2023-06-01");
    assert.equal(h.requests[0].headers.get("authorization"), null);
  });
}

test("Anthropic gateway paths and explicit authHeader/custom-header overrides are preserved", async () => {
  assert.equal(modelsEndpoint(config("anthropic-messages", "https://discovery.invalid/gateway/")).pathname, "/gateway/v1/models");
  assert.equal(modelsEndpoint(config("anthropic-messages", "https://discovery.invalid/gateway/v1")).pathname, "/gateway/v1/models");
  const h = fakeFetch(() => json({ data: [{ id: "fixture" }] }));
  await discoverModels({ ...config("anthropic-messages"), authHeader: true }, { fetch: h.fetch, apiKey: "fixture-key",
    headers: { "Anthropic-Version": "fixture-version", "X-Custom": "custom" } });
  assert.equal(h.requests[0].headers.get("authorization"), "Bearer fixture-key");
  assert.equal(h.requests[0].headers.get("anthropic-version"), "fixture-version");
  assert.equal(h.requests[0].headers.get("x-custom"), "custom");
});

for (const baseUrl of ["https://discovery.invalid", "https://discovery.invalid/", "https://discovery.invalid/v1beta/"]) {
  test(`Google builds /v1beta/models and uses header-only key for ${baseUrl}`, async () => {
    const cfg = config("google-generative-ai", baseUrl);
    assert.equal(modelsEndpoint(cfg).href, "https://discovery.invalid/v1beta/models");
    const h = fakeFetch(() => json({ models: [{ name: "models/gemini-fixture", supportedGenerationMethods: ["generateContent"] }] }));
    assert.deepEqual(await discoverModels(cfg, { fetch: h.fetch, apiKey: "fixture-google-key" }), ["gemini-fixture"]);
    assert.equal(h.requests[0].headers.get("x-goog-api-key"), "fixture-google-key");
    assert.equal(h.requests[0].headers.get("authorization"), null);
    assert.equal(h.requests[0].url.search, "");
    assert.ok(!h.requests[0].url.href.includes("fixture-google-key"));
  });
}

test("Google preserves an explicitly configured version/gateway path", () => {
  for (const path of ["/v1", "/gateway/v1beta"]) {
    assert.equal(modelsEndpoint(config("google-generative-ai", `https://discovery.invalid${path}/`)).pathname, `${path}/models`);
  }
});

test("unsupported APIs and missing/unsafe endpoints fail without a request", async () => {
  const h = fakeFetch(() => { assert.fail("unsupported discovery must not fetch"); });
  for (const cfg of [{ api: "openai-completions" }, { ...config(), baseUrl: 42 }, config("bedrock-converse-stream")]) {
    assert.throws(() => modelsEndpoint(cfg), DiscoveryError);
    await assert.rejects(discoverModels(cfg, { fetch: h.fetch }), DiscoveryError);
  }
  for (const base of ["not-a-url", "file:///tmp/models", "https://user:password@discovery.invalid", "https://discovery.invalid?key=fixture", "https://discovery.invalid/#fragment"]) {
    assert.throws(() => modelsEndpoint(config("openai-completions", base)));
    await assert.rejects(discoverModels(config("openai-completions", base), { fetch: h.fetch }));
  }
  assert.equal(h.requests.length, 0);
});

test("anonymous discovery omits authentication; explicit headers override defaults case-insensitively", async () => {
  for (const api of ["openai-completions", "anthropic-messages", "google-generative-ai"]) {
    const h = fakeFetch(() => json(api === "google-generative-ai" ? { models: [{ name: "fixture" }] } : { data: [{ id: "fixture" }] }));
    await discoverModels(config(api), { fetch: h.fetch });
    for (const name of ["authorization", "x-api-key", "x-goog-api-key"]) assert.equal(h.requests[0].headers.get(name), null);
  }
  const h = fakeFetch(() => json({ data: [{ id: "fixture" }] }));
  await discoverModels(config(), { fetch: h.fetch, apiKey: "default-fixture", headers: { authorization: "Custom fixture", accept: "application/vnd.fixture+json" } });
  assert.equal(h.requests[0].headers.get("authorization"), "Custom fixture");
  assert.equal(h.requests[0].headers.get("accept"), "application/vnd.fixture+json");
});

test("model parsing ignores invalid entries/IDs, deduplicates and sorts without altering valid IDs", async () => {
  const invalidIds = [undefined, null, 12, true, {}, [], "", " leading", "trailing ", "\ttrim", "x".repeat(513),
    ...[0, 1, 9, 10, 13, 31, 127, 128, 159, 0x2028, 0x2029].map(code => `bad${String.fromCharCode(code)}id`)];
  const long = "x".repeat(512);
  const h = fakeFetch(() => json({ data: [null, [], "string", 12, {}, ...invalidIds.map(id => ({ id })),
    { id: "z-model" }, { id: "a-model" }, { id: "z-model" }, { id: "namespace/model:1" }, { id: long }, { id: "A-model" }, { id: "mødel" }] }));
  assert.deepEqual(await discoverModels(config(), { fetch: h.fetch }), ["z-model", "a-model", "namespace/model:1", long, "A-model", "mødel"].sort());
});

test("Google filters non-chat generation methods, strips exactly one models/ prefix and deduplicates", async () => {
  const h = fakeFetch(() => json({ models: [
    { name: "models/z-chat", supportedGenerationMethods: ["countTokens", "generateContent"] },
    { name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
    { name: "models/empty-methods", supportedGenerationMethods: [] },
    { name: "models/z-chat", supportedGenerationMethods: ["generateContent"] },
    { name: "a-unprefixed", supportedGenerationMethods: ["generateContent"] },
    { name: "models/legacy-without-methods" },
    { name: "models/models/nested", supportedGenerationMethods: ["generateContent"] },
    { name: "models/" }, { name: "models/bad\nid" }, null,
  ] }));
  assert.deepEqual(await discoverModels(config("google-generative-ai"), { fetch: h.fetch }),
    ["a-unprefixed", "legacy-without-methods", "models/nested", "z-chat"]);
});

for (const api of ["openai-completions", "anthropic-messages", "google-generative-ai"]) {
  test(`${api} pagination stays on the trusted endpoint and encodes cursors`, async () => {
    const google = api === "google-generative-ai";
    const cursor = "https://untrusted.invalid/path?token=x & slash/+=#";
    const h = fakeFetch((_request, index) => json(google ? {
      models: [{ name: `models/${index ? "a-model" : "z-model"}` }, { name: "models/shared" }],
      ...(index === 0 ? { nextPageToken: cursor } : {}),
    } : {
      data: [{ id: index ? "a-model" : "z-model" }, { id: "shared" }],
      has_more: index === 0, ...(index === 0 ? { last_id: cursor } : {}),
      next: "https://untrusted.invalid/do-not-follow",
    }));
    assert.deepEqual(await discoverModels(config(api), { fetch: h.fetch, apiKey: "fixture-key" }), ["a-model", "shared", "z-model"]);
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[0].url.search, "");
    assert.equal(h.requests[1].url.origin, "https://discovery.invalid");
    assert.equal(h.requests[1].url.pathname, modelsEndpoint(config(api)).pathname);
    assert.deepEqual([...h.requests[1].url.searchParams], [[google ? "pageToken" : "after_id", cursor]]);
    assert.equal(h.requests[0].init.signal, h.requests[1].init.signal);
    assert.deepEqual([...h.requests[0].headers], [...h.requests[1].headers]);
  });
}

for (const google of [false, true]) {
  const api = google ? "google-generative-ai" : "anthropic-messages";
  for (const cursor of [null, 123, {}, [], "x".repeat(4097)]) {
    test(`${api} rejects unsupported pagination cursor ${JSON.stringify(cursor).slice(0, 30)}`, async () => {
      const h = fakeFetch(() => json(google ? { models: [{ name: "models/fixture" }], nextPageToken: cursor }
        : { data: [{ id: "fixture" }], has_more: true, last_id: cursor }));
      await assert.rejects(discoverModels(config(api), { fetch: h.fetch }), manual);
      assert.equal(h.requests.length, 1);
    });
  }
  test(`${api} detects repeated pagination cursors without looping`, async () => {
    const h = fakeFetch(() => json(google ? { models: [{ name: "models/fixture" }], nextPageToken: "repeat" }
      : { data: [{ id: "fixture" }], has_more: true, last_id: "repeat" }));
    await assert.rejects(discoverModels(config(api), { fetch: h.fetch }), manual);
    assert.equal(h.requests.length, 2);
  });
  test(`${api} enforces the ten-page bound`, async () => {
    const h = fakeFetch((_request, index) => json(google ? { models: [{ name: "models/fixture" }], nextPageToken: `next-${index}` }
      : { data: [{ id: "fixture" }], has_more: true, last_id: `next-${index}` }));
    await assert.rejects(discoverModels(config(api), { fetch: h.fetch }), /too many pages; use manual entry/);
    assert.equal(h.requests.length, 10);
  });
}

test("has_more without a usable cursor must not silently return a partial model list", async () => {
  for (const last_id of [undefined, ""]) {
    const h = fakeFetch(() => json({ data: [{ id: "only-first-page" }], has_more: true, last_id }));
    await assert.rejects(discoverModels(config("anthropic-messages"), { fetch: h.fetch }), manual);
    assert.equal(h.requests.length, 1);
  }
});

test("terminal pagination ignores stale non-Google cursors and accepts an empty Google token", async () => {
  const plain = fakeFetch(() => json({ data: [{ id: "fixture" }], has_more: false, last_id: "stale" }));
  assert.deepEqual(await discoverModels(config(), { fetch: plain.fetch }), ["fixture"]);
  const google = fakeFetch(() => json({ models: [{ name: "models/fixture" }], nextPageToken: "" }));
  assert.deepEqual(await discoverModels(config("google-generative-ai"), { fetch: google.fetch }), ["fixture"]);
});

test("pagination accepts empty intermediate pages and a terminal tenth page", async () => {
  const h = fakeFetch((_request, index) => json({ data: index === 9 ? [{ id: "last-page" }] : [], has_more: index < 9, last_id: `cursor-${index}` }));
  assert.deepEqual(await discoverModels(config(), { fetch: h.fetch }), ["last-page"]);
  assert.equal(h.requests.length, 10);
});

test("the 2000-unique-model limit accepts the boundary and rejects cumulative overflow", async () => {
  const entries = Array.from({ length: 2000 }, (_, i) => ({ id: `fixture-${i}` }));
  const exact = fakeFetch(() => json({ data: [...entries, entries[0]] }));
  assert.equal((await discoverModels(config(), { fetch: exact.fetch })).length, 2000);
  const overflow = fakeFetch((_request, index) => json({ data: index ? [{ id: "one-too-many" }] : entries, has_more: index === 0, last_id: "next" }));
  await assert.rejects(discoverModels(config(), { fetch: overflow.fetch }), /too large; use manual entry/);
  assert.equal(overflow.requests.length, 2);
});

test("response byte limit cancels streaming bodies and counts bytes across pages", async () => {
  let cancelled = false;
  const tooLarge = fakeFetch(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(discoverModels(config(), { fetch: tooLarge.fetch }), /too large; use manual entry/);
  assert.equal(cancelled, true);
  const cumulative = fakeFetch((_request, index) => json({ data: [{ id: "fixture" }], padding: "x".repeat(1100 * 1024), has_more: index === 0, last_id: "next" }));
  await assert.rejects(discoverModels(config(), { fetch: cumulative.fetch }), /too large; use manual entry/);
  assert.equal(cumulative.requests.length, 2);
});

test("exactly 2 MiB of valid JSON remains supported", async () => {
  const prefix = '{"data":[{"id":"fixture"}],"padding":"';
  const suffix = '"}';
  const body = prefix + "x".repeat(2 * 1024 * 1024 - Buffer.byteLength(prefix + suffix)) + suffix;
  const h = fakeFetch(() => new Response(body));
  assert.deepEqual(await discoverModels(config(), { fetch: h.fetch }), ["fixture"]);
});

for (const status of [301, 400, 401, 403, 429, 500, 503]) {
  test(`HTTP ${status} is sanitized, cancels the unread body and does not retry`, async () => {
    let cancelled = false;
    let read = false;
    const h = fakeFetch(() => new Response(new ReadableStream<Uint8Array>({
      pull() { read = true; throw new Error("fixture-raw-body-secret"); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { status }));
    await assert.rejects(discoverModels(config(), { fetch: h.fetch }), error => {
      assert.ok(error instanceof DiscoveryError);
      assert.equal(error.message, `The model-list endpoint returned HTTP ${status}.`);
      assert.doesNotMatch(error.message, /fixture-raw-body-secret/);
      return true;
    });
    assert.equal(cancelled, true);
    assert.equal(read, false);
    assert.equal(h.requests.length, 1);
  });
}

test("malformed/empty JSON responses produce safe errors without raw body or key leakage", async () => {
  for (const body of ["", "<html>fixture-raw-body-secret</html>", '{"data": [', "fixture-raw-body-secret"]) {
    const h = fakeFetch(() => new Response(body));
    await assert.rejects(discoverModels(config(), { fetch: h.fetch, apiKey: "fixture-auth-secret" }), error => {
      assert.ok(error instanceof DiscoveryError);
      assert.equal(error.message, "The endpoint did not return a JSON model list.");
      assert.doesNotMatch(error.message, /fixture-raw-body-secret|fixture-auth-secret/);
      return true;
    });
  }
  const noBody = fakeFetch(() => new Response(null, { status: 204 }));
  await assert.rejects(discoverModels(config(), { fetch: noBody.fetch }), /did not return a JSON model list/);
});

test("unsupported JSON shapes and lists with no usable models produce safe errors", async () => {
  for (const payload of [null, [], "fixture-raw-body-secret", 42, true, {}, { data: null }, { data: {} }, { models: [] }]) {
    const h = fakeFetch(() => json(payload));
    await assert.rejects(discoverModels(config(), { fetch: h.fetch }), error => {
      assert.ok(error instanceof DiscoveryError);
      assert.equal(error.message, "The endpoint did not return a supported model list.");
      return true;
    });
  }
  for (const [cfg, payload] of [
    [config(), { data: [] }], [config(), { data: [null, {}, { id: " bad " }] }],
    [config("google-generative-ai"), { models: [{ name: "models/embed", supportedGenerationMethods: ["embedContent"] }] }],
  ] as const) {
    const h = fakeFetch(() => json(payload));
    await assert.rejects(discoverModels(cfg, { fetch: h.fetch }), error => {
      assert.ok(error instanceof DiscoveryError);
      assert.equal(error.message, "The endpoint returned no usable models.");
      return true;
    });
  }
});

test("streamed UTF-8 JSON is decoded across chunk boundaries", async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ data: [{ id: "mødel-模型" }] }));
  const h = fakeFetch(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const byte of encoded) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
  })));
  assert.deepEqual(await discoverModels(config(), { fetch: h.fetch }), ["mødel-模型"]);
});

test("caller AbortSignal is composed and remains active across pagination", async () => {
  const controller = new AbortController();
  const reason = new Error("fixture-caller-abort");
  const h = fakeFetch((request, index) => {
    assert.ok(request.init.signal instanceof AbortSignal);
    if (index === 0) return json({ data: [{ id: "first-page" }], has_more: true, last_id: "next" });
    controller.abort(reason);
    request.init.signal.throwIfAborted();
    assert.fail("abort must stop pagination");
  });
  await assert.rejects(discoverModels(config(), { fetch: h.fetch, signal: controller.signal }), error => error === reason);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].init.signal, h.requests[1].init.signal);
  assert.notEqual(h.requests[0].init.signal, controller.signal);
  assert.equal(h.requests[0].init.signal?.aborted, true);
});

test("real loopback fetch refuses redirects before credentials can reach the target", { timeout: 2000 }, async () => {
  const paths: string[] = [];
  await localServer((request, response) => {
    paths.push(request.url!);
    if (request.url === "/v1/models") {
      response.writeHead(302, { Location: "/redirect-target" });
      response.end("fixture-redirect-body-secret");
    } else { response.end(JSON.stringify({ data: [{ id: "must-not-follow" }] })); }
  }, async baseUrl => {
    await assert.rejects(discoverModels(config("openai-completions", `${baseUrl}/v1`), { apiKey: "fixture-local-key" }), error => {
      assert.ok(error instanceof TypeError);
      assert.doesNotMatch(error.message, /fixture-local-key|fixture-redirect-body-secret/);
      return true;
    });
    assert.deepEqual(paths, ["/v1/models"]);
  });
});

for (const api of ["openai-completions", "openai-responses"]) {
  test(`${api} returns only allowlisted validated model metadata in one fetch`, async () => {
    const h = fakeFetch(() => json({ data: [{
      id: "fixture", name: "Fixture Model", context_length: 128000, max_output_tokens: 8192,
      reasoning: true, input: ["image", "text", "image"],
      apiKey: "must-not-persist", headers: { Authorization: "must-not-persist" },
      owned_by: "fixture-owner", cost: { input: 1 }, extra: { nested: true },
    }] }));
    const expected: DiscoveredModel[] = [{
      id: "fixture", name: "Fixture Model", contextWindow: 128000, maxTokens: 8192,
      reasoning: true, input: ["text", "image"],
    }];
    assert.deepEqual(await discoverModelDetails(config(api), { fetch: h.fetch, apiKey: "fixture-key" }), expected);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].init.method, "GET");
    assert.equal(h.requests[0].init.redirect, "error");
    assert.equal(h.requests[0].headers.get("authorization"), "Bearer fixture-key");
  });
}

for (const field of ["context_length", "context_window", "contextWindow", "max_model_len"]) {
  test(`metadata accepts the explicit ${field} context limit`, async () => {
    const h = fakeFetch(() => json({ data: [{ id: "fixture", [field]: 12345 }] }));
    assert.deepEqual(await discoverModelDetails(config(), { fetch: h.fetch }), [{ id: "fixture", contextWindow: 12345 }]);
  });
}

for (const field of ["max_output_tokens", "maxTokens"]) {
  test(`metadata accepts the explicit ${field} output limit`, async () => {
    const h = fakeFetch(() => json({ data: [{ id: "fixture", [field]: 1024 }] }));
    assert.deepEqual(await discoverModelDetails(config(), { fetch: h.fetch }), [{ id: "fixture", maxTokens: 1024 }]);
  });
}

test("metadata limits require safe positive integers and skip invalid aliases", async () => {
  for (const value of [null, false, true, "8192", "", {}, [], 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity]) {
    const h = fakeFetch(() => json({ data: [{
      id: "fixture", context_length: value, context_window: value, contextWindow: value, max_model_len: value,
      max_output_tokens: value, maxTokens: value,
      top_provider: { context_length: value, max_completion_tokens: value },
    }] }));
    assert.deepEqual(await discoverModelDetails(config(), { fetch: h.fetch }), [{ id: "fixture" }]);
  }
  const fallback = fakeFetch(() => json({ data: [{
    id: "fixture", context_length: "invalid", context_window: 1, contextWindow: 999,
    max_output_tokens: -1, maxTokens: Number.MAX_SAFE_INTEGER,
  }] }));
  assert.deepEqual(await discoverModelDetails(config(), { fetch: fallback.fetch }), [{
    id: "fixture", contextWindow: 1, maxTokens: Number.MAX_SAFE_INTEGER,
  }]);
});

test("missing metadata remains absent and model IDs never imply capabilities", async () => {
  const h = fakeFetch(() => json({ data: [
    { id: "vision-reasoning-thinking-image-model", description: "Supports images and reasoning" },
    { id: "plain" }, { id: "__proto__" }, { id: "constructor" },
  ] }));
  assert.deepEqual(await discoverModelDetails(config(), { fetch: h.fetch }), [
    { id: "__proto__" }, { id: "constructor" }, { id: "plain" }, { id: "vision-reasoning-thinking-image-model" },
  ]);
});

test("unsafe or unsupported display names are omitted without discarding the model", async () => {
  const names = [null, true, 123, {}, [], "", " leading", "trailing ", "x".repeat(513),
    ...[0, 1, 9, 10, 13, 31, 127, 128, 159, 0x2028, 0x2029].map(code => `bad${String.fromCharCode(code)}name`)];
  for (const [api, field] of [
    ["openai-completions", "name"], ["anthropic-messages", "display_name"], ["google-generative-ai", "displayName"],
  ]) {
    const google = api === "google-generative-ai";
    const entries = names.map((name, index) => ({ ...(google ? { name: `models/fixture-${index}` } : { id: `fixture-${index}` }), [field]: name }));
    entries.push({ ...(google ? { name: "models/valid" } : { id: "valid" }), [field]: "Modèle 模型" });
    entries.push({ ...(google ? { name: "models/boundary" } : { id: "boundary" }), [field]: "x".repeat(512) });
    const h = fakeFetch(() => json({ [google ? "models" : "data"]: entries }));
    const details = await discoverModelDetails(config(api), { fetch: h.fetch });
    assert.deepEqual(details.filter(model => model.id.startsWith("fixture-")), names.map((_, index) => ({ id: `fixture-${index}` })).sort((a, b) => a.id < b.id ? -1 : 1));
    assert.equal(details.find(model => model.id === "valid")?.name, "Modèle 模型");
    assert.equal(details.find(model => model.id === "boundary")?.name, "x".repeat(512));
  }
});

test("OpenRouter nested provider limits and explicit capability declarations are normalized", async () => {
  const h = fakeFetch(() => json({ data: [{
    id: "router/fixture", name: "Router Fixture", context_length: 0,
    top_provider: { context_length: 65536, max_completion_tokens: 4096, is_moderated: true },
    architecture: { input_modalities: ["text", "image", "audio", "file"], output_modalities: ["text"] },
    supported_parameters: ["temperature", "reasoning"],
  }, {
    id: "router/precedence", context_length: 16384, max_output_tokens: 2048, reasoning: false,
    top_provider: { context_length: 32768, max_completion_tokens: 8192 }, supported_parameters: ["reasoning"],
  }] }));
  assert.deepEqual(await discoverModelDetails(config(), { fetch: h.fetch }), [{
    id: "router/fixture", name: "Router Fixture", contextWindow: 65536, maxTokens: 4096,
    reasoning: true, input: ["text", "image"],
  }, { id: "router/precedence", contextWindow: 16384, maxTokens: 2048, reasoning: false }]);
});

test("invalid nested objects and ambiguous capability declarations do not produce metadata", async () => {
  for (const value of [null, false, true, 42, "text,image", [], { unexpected: true }]) {
    const h = fakeFetch(() => json({ data: [{
      id: "fixture", reasoning: value, supports_reasoning: value,
      input: value, architecture: value, top_provider: value, supported_parameters: value,
    }] }));
    const expected: DiscoveredModel = { id: "fixture" };
    if (typeof value === "boolean") expected.reasoning = value;
    assert.deepEqual(await discoverModelDetails(config(), { fetch: h.fetch }), [expected]);
  }
  const h = fakeFetch(() => json({ data: [{
    id: "fixture", reasoning: { enabled: true }, input: ["audio", "TEXT", {}, ["image"]],
    architecture: { modality: "text+image->text", output_modalities: ["image"] },
    supported_parameters: ["include_reasoning", "reasoning_effort"],
  }, { id: "explicit", supports_reasoning: false, input: ["text", "audio"] }] }));
  assert.deepEqual(await discoverModelDetails(config(), { fetch: h.fetch }), [
    { id: "explicit", reasoning: false, input: ["text"] }, { id: "fixture" },
  ]);
});

test("Gemini maps displayName and conservative input/output limits without guessing capabilities", async () => {
  const h = fakeFetch(() => json({ models: [{
    name: "models/gemini-fixture", displayName: "Gemini Fixture", inputTokenLimit: 1000000, outputTokenLimit: 8192,
    supportedGenerationMethods: ["generateContent"], version: "001", description: "Multimodal reasoning",
  }, {
    name: "models/explicit", inputTokenLimit: 10, outputTokenLimit: 20, reasoning: true, input: ["image", "text"],
  }, { name: "models/missing" }, {
    name: "models/embed", inputTokenLimit: 123, supportedGenerationMethods: ["embedContent"],
  }] }));
  assert.deepEqual(await discoverModelDetails(config("google-generative-ai"), { fetch: h.fetch }), [
    { id: "explicit", contextWindow: 10, maxTokens: 20, reasoning: true, input: ["text", "image"] },
    { id: "gemini-fixture", name: "Gemini Fixture", contextWindow: 1000000, maxTokens: 8192 }, { id: "missing" },
  ]);
  for (const value of [null, 0, -1, 1.5, "4096", true, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = fakeFetch(() => json({ models: [{ name: "models/fixture", inputTokenLimit: value, outputTokenLimit: value }] }));
    assert.deepEqual(await discoverModelDetails(config("google-generative-ai"), { fetch: invalid.fetch }), [{ id: "fixture" }]);
  }
});

test("Anthropic retains display_name and only optional explicit limits/capabilities", async () => {
  const h = fakeFetch(() => json({ data: [{
    id: "claude-fixture", display_name: "Claude Fixture", created_at: "2026-01-01", type: "model",
  }, {
    id: "claude-explicit", display_name: "Explicit Claude", context_window: 200000, max_output_tokens: 16000,
    reasoning: false, input: ["text", "image"],
  }] }));
  assert.deepEqual(await discoverModelDetails(config("anthropic-messages"), { fetch: h.fetch, apiKey: "fixture-key" }), [
    { id: "claude-explicit", name: "Explicit Claude", contextWindow: 200000, maxTokens: 16000, reasoning: false, input: ["text", "image"] },
    { id: "claude-fixture", name: "Claude Fixture" },
  ]);
  assert.equal(h.requests[0].headers.get("x-api-key"), "fixture-key");
  assert.equal(h.requests[0].headers.get("anthropic-version"), "2023-06-01");
});

for (const api of ["openai-completions", "anthropic-messages", "google-generative-ai"]) {
  test(`${api} details merge duplicate metadata across one pagination pass`, async () => {
    const google = api === "google-generative-ai";
    const nameField = google ? "displayName" : api === "anthropic-messages" ? "display_name" : "name";
    const contextField = google ? "inputTokenLimit" : "context_length";
    const outputField = google ? "outputTokenLimit" : "maxTokens";
    const entry = (id: string, metadata: Record<string, unknown> = {}) => ({ ...(google ? { name: `models/${id}` } : { id }), ...metadata });
    const cursor = "https://untrusted.invalid/next?token=a &b";
    const h = fakeFetch((_request, index) => json({
      [google ? "models" : "data"]: index === 0 ? [
        entry("z-model"), entry("shared", { [nameField]: "Shared", [contextField]: 1234, reasoning: false, input: ["text"] }),
        entry("sparse", { [nameField]: "bad\nname", [contextField]: -1 }),
      ] : [
        entry("a-model"), entry("shared", { [nameField]: "Conflicting", [contextField]: 9999, [outputField]: 100, reasoning: true, input: ["image"] }),
        entry("shared"), entry("sparse", { [nameField]: "Enriched", [contextField]: 2048 }),
      ],
      ...(google ? index === 0 ? { nextPageToken: cursor } : {} : { has_more: index === 0, last_id: cursor }),
    }));
    assert.deepEqual(await discoverModelDetails(config(api), { fetch: h.fetch, apiKey: "fixture-key" }), [
      { id: "a-model" }, { id: "shared", name: "Shared", contextWindow: 1234, maxTokens: 100, reasoning: false, input: ["text", "image"] },
      { id: "sparse", name: "Enriched", contextWindow: 2048 }, { id: "z-model" },
    ]);
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].url.origin, h.requests[0].url.origin);
    assert.equal(h.requests[1].url.pathname, h.requests[0].url.pathname);
    assert.equal(h.requests[1].url.searchParams.get(google ? "pageToken" : "after_id"), cursor);
    assert.equal(h.requests[1].init.signal, h.requests[0].init.signal);
    assert.deepEqual([...h.requests[1].headers], [...h.requests[0].headers]);
    assert.ok(h.requests.every(request => request.init.redirect === "error"));
  });
}

test("real loopback fetch honors discovery timeout and caller cancellation", { timeout: 2000 }, async () => {
  await localServer((_request, _response) => { /* Intentionally never complete the response. */ }, async baseUrl => {
    const cfg = config("openai-completions", `${baseUrl}/v1`);
    await assert.rejects(discoverModels(cfg, { timeoutMs: 50 }), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "TimeoutError");
      return true;
    });
    const controller = new AbortController();
    const pending = discoverModels(cfg, { signal: controller.signal, timeoutMs: 5000 });
    controller.abort();
    await assert.rejects(pending, error => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "AbortError");
      return true;
    });
  });
});
