import { objectSchema } from "./http-schema-policy.ts";

const PROMPT_IMAGE = objectSchema({
  data: { type: "string", minLength: 1, maxLength: 6_000_000 },
  mimeType: { type: "string", pattern: "^image/" },
}, ["data", "mimeType"]);

export const SESSION_COMMAND_SCHEMA = {
  ...objectSchema({ type: { enum: ["prompt", "abort", "get_state", "web_command"] } }, ["type"]),
  allOf: [
    {
      if: objectSchema({ type: { const: "prompt" } }, ["type"]),
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema conditional, not a callable promise.
      then: objectSchema({ message: { type: "string" }, images: { type: "array", maxItems: 8, items: PROMPT_IMAGE } }, ["message"]),
    },
    {
      if: objectSchema({ type: { const: "web_command" } }, ["type"]),
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema conditional, not a callable promise.
      then: objectSchema({ name: { type: "string", pattern: "^\\s*[a-zA-Z0-9][a-zA-Z0-9_-]*\\s*$" } }, ["name"]),
    },
  ],
};

/** Preserve actionable historical errors without implementing a second validator. */
export function sessionCommandSchemaError(error: { instancePath: string; keyword: string; params: Record<string, unknown> }): string {
  const { instancePath: path, keyword, params } = error;
  const field = params.missingProperty;
  if (path === "" && keyword === "type") return "body must be an object";
  if (field === "message" || path === "/message") return "prompt requires a message";
  if (field === "name" || path === "/name") return "web_command requires a name (a simple identifier)";
  if (path === "/images" && keyword === "type") return "images must be an array";
  if (path === "/images" && keyword === "maxItems") return "too many images (max 8)";
  if (path.startsWith("/images/")) {
    if (keyword === "maxLength") return "image too large (max ~6 MB of base64 per image)";
    if (field === "mimeType" || path.endsWith("/mimeType")) return "images entries require an image/* mimeType";
    if (field === "data" || path.endsWith("/data")) return "images entries require non-empty data";
    return "images entries must be objects";
  }
  return "unknown command type";
}
