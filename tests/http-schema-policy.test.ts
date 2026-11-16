import test from "node:test";
import assert from "node:assert/strict";
import { firstQueryValues, HTTP_AJV_OPTIONS, HTTP_HEADERS_SCHEMA, objectSchema, routeParamsSchema } from "../lib/http-schema-policy.ts";
import { Ajv } from "ajv";
import { SESSION_COMMAND_SCHEMA, sessionCommandSchemaError } from "../lib/session-command-schema.ts";
import { PI_API_BODY_SCHEMA } from "../lib/pi-api-schema.ts";
import { GRAPH_LEASE_SCHEMA, GRAPH_PUBLISH_SCHEMA, graphSchemaError } from "../lib/graph-request-schema.ts";

// Exercise the root install independently; web tests exercise the web engine.
const compiler = new Ajv(HTTP_AJV_OPTIONS);
function compileHttpSchema(schema: Record<string, unknown>) { return compiler.compile(schema); }

test("HTTP schemas never coerce numbers, insert defaults or strip extension-owned fields", () => {
  assert.equal(HTTP_AJV_OPTIONS.coerceTypes, false);
  const validate = compileHttpSchema(objectSchema({ value: { type: "integer", default: 7 } }));
  const missing = { extension: { nested: true } };
  assert.equal(validate(missing), true);
  assert.deepEqual(missing, { extension: { nested: true } });
  const wrong = { value: "7", extension: 1 };
  assert.equal(validate(wrong), false);
  assert.deepEqual(wrong, { value: "7", extension: 1 });
});

test("native query policy preserves first values and treats prototype names as own properties", () => {
  const query = firstQueryValues("q=first&q=last&path=a%2Fb&__proto__=literal");
  assert.equal(query.q, "first");
  assert.equal(query.path, "a/b");
  assert.equal(Object.hasOwn(query, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(query), Object.prototype);
  assert.deepEqual(routeParamsSchema("/api/plugin-manager/:id/:command").required, ["id", "command"]);
  assert.equal(compileHttpSchema(HTTP_HEADERS_SCHEMA)({ authorization: "Bearer x", extension: "kept" }), true);
  // Duplicate credential headers surface as arrays and must not fail the schema.
  assert.equal(compileHttpSchema(HTTP_HEADERS_SCHEMA)({ authorization: ["Bearer x", "Bearer y"], cookie: ["a=1", "b=2"] }), true);
});

test("command schema owns bounded attachments and reports field-specific errors", () => {
  const validate = compileHttpSchema(SESSION_COMMAND_SCHEMA);
  assert.equal(validate({ type: "prompt", message: "", images: [{ data: "x", mimeType: "image/png" }], extension: 1 }), true);
  assert.equal(validate({ type: "prompt", message: 42 }), false);
  assert.match(sessionCommandSchemaError(validate.errors![0]!), /requires a message/);
  assert.equal(validate({ type: "prompt", message: "ok", images: Array.from({ length: 9 }, () => ({ data: "x", mimeType: "image/png" })) }), false);
  assert.match(sessionCommandSchemaError(validate.errors![0]!), /too many images/);
});

test("pi_api conditional schemas validate write shapes without restricting extension config", () => {
  const validate = compileHttpSchema(PI_API_BODY_SCHEMA);
  for (const body of [
    { api: "commands.builtin" },
    { api: "settings.write", params: { key: "name", value: null } },
    { api: "mcp.write", params: { action: "add", scope: "project", name: "test", config: { extension: { arbitrary: true } } } },
  ]) assert.equal(validate(body), true, JSON.stringify(validate.errors));
  for (const body of [
    { api: "unknown" }, { api: "autocomplete.suggestions", params: { line: "x", cursorCol: "1" } },
    { api: "mcp.write", params: { action: "add", name: "test", config: {} } },
    { api: "mcp.write", params: { action: "patch", name: "test" } },
    { api: "auth.login", params: { providerId: "p", authType: "invalid" } },
  ]) assert.equal(validate(body), false, JSON.stringify(body));
});

test("graph lease schemas reject coercion and out-of-range revisions but preserve null generation", () => {
  const lease = { sessionId: "session", producerId: "producer_test", generation: null };
  assert.equal(compileHttpSchema(GRAPH_LEASE_SCHEMA)(lease), true);
  const publish = compileHttpSchema(GRAPH_PUBLISH_SCHEMA);
  assert.equal(publish({ ...lease, revision: 1, snapshot: { custom: true } }), true);
  assert.equal(publish({ ...lease, revision: "1" }), false);
  assert.equal(graphSchemaError(publish.errors![0]!), "invalid revision");
  assert.equal(publish({ ...lease, revision: 1e9 + 1 }), false);
});
