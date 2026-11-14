import test from "node:test";
import assert from "node:assert/strict";
import { getJson, postJson, requestJson } from "./api-client.ts";

type FetchArgs = { url: string; init?: RequestInit };

/** Replace global fetch for one test and restore it afterwards. */
async function withFetch(
  reply: (args: FetchArgs) => Response | Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: FetchArgs[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const args = { url: String(input), ...(init !== undefined ? { init } : {}) };
    calls.push(args);
    return reply(args);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("a successful response is returned as data", async () => {
  await withFetch(() => jsonResponse({ entries: [1, 2] }), async () => {
    const outcome = await getJson<{ entries: number[] }>("/api/thing");
    assert.deepEqual(outcome, { ok: true, data: { entries: [1, 2] } });
  });
});

test("a non-2xx response carries the server's code, message and status", async () => {
  await withFetch(() => jsonResponse({ error: "path escapes the root", code: "forbidden" }, 403), async () => {
    const outcome = await getJson("/api/thing");
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.code, "forbidden");
    assert.equal(outcome.message, "path escapes the root");
    assert.equal(outcome.status, 403);
  });
});

test("an error without a code or message still names the status", async () => {
  await withFetch(() => new Response("not json", { status: 502 }), async () => {
    const outcome = await getJson("/api/thing");
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.code, "error");
    assert.equal(outcome.message, "request failed (HTTP 502)");
    assert.equal(outcome.status, 502);
  });
});

test("a thrown fetch is a network failure, not an exception", async () => {
  await withFetch(() => {
    throw new TypeError("Failed to fetch");
  }, async () => {
    const outcome = await getJson("/api/thing");
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.code, "network");
    assert.equal(outcome.status, 0);
  });
});

test("postJson sends a JSON body with its content type", async () => {
  let seen: FetchArgs | undefined;
  await withFetch((args) => {
    seen = args;
    return jsonResponse({ ok: true });
  }, async () => {
    const outcome = await postJson("/api/thing", { api: "mcp.read", params: {} });
    assert.equal(outcome.ok, true);
  });

  assert.equal(seen?.init?.method, "POST");
  assert.equal(seen?.init?.body, JSON.stringify({ api: "mcp.read", params: {} }));
  const headers = seen?.init?.headers as Record<string, string>;
  assert.equal(headers["Content-Type"], "application/json");
});

test("a GET sends no body and no content type", async () => {
  let seen: FetchArgs | undefined;
  await withFetch((args) => {
    seen = args;
    return jsonResponse({});
  }, async () => {
    await requestJson({ url: "/api/thing" });
  });

  assert.equal(seen?.init?.method, "GET");
  assert.equal(seen?.init?.body, undefined);
  const headers = seen?.init?.headers as Record<string, string>;
  assert.equal(headers["Content-Type"], undefined);
  assert.equal(headers.Accept, "application/json");
});
