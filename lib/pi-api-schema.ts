import { objectSchema } from "./http-schema-policy.ts";

const text = { type: "string" };
const nonBlank = { type: "string", pattern: "\\S" };
const named = (field: string) => objectSchema({ [field]: nonBlank }, [field]);
const MCP_WRITE_SCHEMA = {
  ...objectSchema({
    action: { enum: ["add", "remove", "patch", "override"] },
    name: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
    enabled: { type: "boolean" },
    exposure: { enum: ["codemode", "deferred", "direct", "hidden"] },
  }, ["action", "name"]),
  allOf: [
    // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema conditional, not a callable promise.
    { if: objectSchema({ action: { enum: ["patch", "override"] } }, ["action"]), then: { anyOf: [{ required: ["enabled"] }, { required: ["exposure"] }] } },
    // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema conditional, not a callable promise.
    { if: objectSchema({ action: { enum: ["add", "remove"] } }, ["action"]), then: objectSchema({ scope: { enum: ["global", "project"] } }, ["scope"]) },
    // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema conditional, not a callable promise.
    { if: objectSchema({ action: { const: "add" } }, ["action"]), then: objectSchema({ config: { type: "object", additionalProperties: true } }, ["config"]) },
  ],
};

const PARAMS: Record<string, Record<string, unknown>> = {
  "autocomplete.suggestions": objectSchema({ line: text, cursorCol: { type: "integer", minimum: 0 } }, ["line", "cursorCol"]),
  "settings.write": objectSchema({ key: { type: "string", minLength: 1 }, value: { type: ["string", "number", "boolean", "null"] } }, ["key", "value"]),
  "settings.models.write": objectSchema({ patterns: { anyOf: [{ type: "null" }, { type: "array", items: nonBlank }] } }, ["patterns"]),
  "trust.write": named("label"),
  "auth.login": objectSchema({ providerId: nonBlank, authType: { enum: ["oauth", "api_key"] } }, ["providerId", "authType"]),
  "auth.state": objectSchema({ loginId: text }, ["loginId"]),
  "auth.answer": objectSchema({ loginId: text, value: text }, ["loginId", "value"]),
  "auth.logout": named("providerId"),
  "mcp.write": MCP_WRITE_SCHEMA,
};
const READ_APIS = ["commands.builtin", "settings.read", "settings.models.read", "trust.read", "auth.read", "mcp.read"];

export const PI_API_BODY_SCHEMA = {
  ...objectSchema({ api: { enum: [...READ_APIS, ...Object.keys(PARAMS)] } }, ["api"]),
  allOf: Object.entries(PARAMS).map(([api, params]) => ({
    if: objectSchema({ api: { const: api } }, ["api"]),
    // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema conditional, not a callable promise.
    then: objectSchema({ params }, ["params"]),
  })),
};
