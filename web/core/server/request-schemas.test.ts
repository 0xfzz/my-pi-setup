import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { createWebApp } from "./app.ts";
import { registerCoreRoutes } from "./routes.ts";
import { clearSessionsForTests, registerSession, type SessionCore } from "./sessions.ts";

async function api() {
  const app = await createWebApp();
  await registerCoreRoutes(app);
  return app;
}

function core(overrides: Partial<SessionCore> = {}): SessionCore {
  return {
    sessionId: "schema-session", subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, isStreaming: () => false,
    getState: () => ({ sessionId: "schema-session", sessionFile: "", isStreaming: false, isBashRunning: false, isCompacting: false, model: undefined, contextUsage: null, thinkingLevel: "off" }),
    ...overrides,
  };
}

test.afterEach(clearSessionsForTests);

test("core schemas do not coerce model inputs or strip extension fields, and preserve session-before-shape errors", async () => {
  const app = await api();
  const applied: string[] = [];
  registerSession(core({ setModel: async (provider, id) => { applied.push(`${provider}/${id}`); return true; } }), tmpdir());
  try {
    const invalid = await app.inject({ method: "POST", url: "/api/agent/schema-session/model", payload: { provider: 42, id: "m" } });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.json(), { error: "provider and id are required" });
    const missing = await app.inject({ method: "POST", url: "/api/agent/schema-missing/model", payload: { provider: 42 } });
    assert.equal(missing.statusCode, 404);
    const valid = await app.inject({ method: "POST", url: "/api/agent/schema-session/model", payload: { provider: "p", id: "m", extension: { kept: true } } });
    assert.equal(valid.statusCode, 200);
    assert.deepEqual(applied, ["p/m"]);
  } finally { await app.close(); }
});

test("native bodies are parsed once regardless of Content-Type, with strict command shapes and unchanged state", async () => {
  const app = await api();
  registerSession(core(), tmpdir());
  const observed: unknown[] = [];
  app.addHook("preHandler", async request => { observed.push(request.body); });
  try {
    const payload = { type: "get_state", extension: { untouched: true }, constructor: { prototype: { safe: true } } };
    const response = await app.inject({ method: "POST", url: "/api/agent/schema-session", headers: { "content-type": "text/plain" }, payload: JSON.stringify(payload) });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(observed[0], payload);
    const invalid = await app.inject({ method: "POST", url: "/api/agent/schema-session", payload: { type: "prompt", message: 42 } });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.json().error, /requires a message/);
    const query = await app.inject({ url: "/api/agent/schema-session?keep=first&keep=last" });
    assert.equal(query.statusCode, 200);
    assert.equal(query.json().state.sessionId, "schema-session");
  } finally { await app.close(); }
});

test("known method misses and unauthorized misses reject before parsing or validation", async () => {
  const app = await api();
  let consumed = 0;
  app.addHook("preParsing", async (_request, _reply, payload) => { consumed++; return payload; });
  try {
    for (const url of ["/api/agent/schema-session/model", "/api/agent/schema-session", "/api/health"]) {
      const response = await app.inject({ method: "PUT", url, headers: { "content-type": "application/json" }, payload: "{broken" });
      assert.equal(response.statusCode, 405);
    }
    assert.equal(consumed, 0);
  } finally { await app.close(); }
  const guarded = await createWebApp({ authorize: (_request, reply) => { void reply.code(401).send({ error: "unauthenticated" }); return false; } });
  await registerCoreRoutes(guarded);
  try {
    const response = await guarded.inject({ method: "POST", url: "/api/not-found", payload: "{broken", headers: { "content-type": "application/json" } });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: "unauthenticated" });
  } finally { await guarded.close(); }
});
