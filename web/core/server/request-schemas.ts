import type { FastifySchema } from "fastify";
import { HTTP_HEADERS_SCHEMA, objectSchema, routeParamsSchema } from "../../../lib/http-schema-policy.ts";
import { MAX_ACTION_VALUES, MAX_ACTION_VALUE_CHARS } from "../plugin-contracts/actions.ts";

export const MODEL_BODY_SCHEMA = objectSchema({ provider: { type: "string" }, id: { type: "string" } }, ["provider", "id"]);
export const THINKING_BODY_SCHEMA = objectSchema({ level: { type: "string" } }, ["level"]);
export const AUTH_LOGIN_SCHEMA = objectSchema({ password: { type: "string" } }, ["password"]);
export const AUTH_REFRESH_SCHEMA = objectSchema({});
export const ACTION_BODY_SCHEMA = objectSchema({
  sessionId: { type: "string" }, pluginId: { type: "string" }, actionId: { type: "string" },
  values: { type: "object", maxProperties: MAX_ACTION_VALUES, propertyNames: { pattern: "^[a-z][a-zA-Z0-9_-]*$" }, additionalProperties: { type: "string", maxLength: MAX_ACTION_VALUE_CHARS } },
});

/** Optional values on permissive endpoints historically select fallbacks, not errors. */
export const PERMISSIVE_BODY_SCHEMA = { type: ["object", "array", "string", "number", "boolean", "null"] };

export function coreRequestSchema(options: { path: string; body?: Record<string, unknown>; query?: readonly string[] }): FastifySchema {
  return {
    params: routeParamsSchema(options.path),
    querystring: objectSchema(Object.fromEntries((options.query ?? []).map(name => [name, { type: "string" }]))),
    headers: HTTP_HEADERS_SCHEMA,
    ...(options.body ? { body: options.body } : {}),
  };
}
