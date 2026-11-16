import { objectSchema } from "./http-schema-policy.ts";

export const GRAPH_LEASE_SCHEMA = objectSchema({
  sessionId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$" },
  producerId: { type: "string", pattern: "^[A-Za-z0-9_-]{8,64}$" },
  generation: { type: ["integer", "null"], minimum: 0, maximum: 1e9 },
}, ["sessionId", "producerId"]);

export const GRAPH_PUBLISH_SCHEMA = {
  ...GRAPH_LEASE_SCHEMA,
  allOf: [objectSchema({ revision: { type: "integer", minimum: 1, maximum: 1e9 } }, ["revision"])],
};

export function graphSchemaError(error: { instancePath: string; params: Record<string, unknown> }): string {
  const field = error.params.missingProperty ?? error.instancePath.slice(1);
  return `invalid ${String(field || "request")}`;
}
