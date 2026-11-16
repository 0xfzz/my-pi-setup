/** Shared by Fastify and independently callable wire validators. Never mutate input. */
export const HTTP_AJV_OPTIONS = {
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  allErrors: false,
  ownProperties: true,
  allowUnionTypes: true,
};

export function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: true };
}

/** Node surfaces duplicate credential headers as arrays; accept both shapes. */
const HEADER_VALUE = { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] };

/** WHATWG parsing, with the established first-value policy for duplicate keys. */
export function firstQueryValues(query: string): Record<string, string> {
  return Object.fromEntries([...new URLSearchParams(query)].reverse());
}

/** Generated from route declarations, never used to match a request path. */
export function routeParamsSchema(path: string): Record<string, unknown> {
  const names = path.split("/").filter(part => part.startsWith(":")).map(part => part.slice(1));
  return objectSchema(Object.fromEntries(names.map(name => [name, { type: "string" }])), names);
}

export const HTTP_HEADERS_SCHEMA = objectSchema({
  authorization: HEADER_VALUE, cookie: HEADER_VALUE, "content-type": HEADER_VALUE,
});
