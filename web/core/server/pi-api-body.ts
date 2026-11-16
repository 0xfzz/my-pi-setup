import { compileHttpSchema } from "../http/schema.ts";
import { PI_API_BODY_SCHEMA } from "../../../lib/pi-api-schema.ts";
import type { PiApiName } from "../shared/pi-api.ts";

const validateBody = compileHttpSchema<{ api: PiApiName; params?: unknown }>(PI_API_BODY_SCHEMA);

/** Structural checks are shared JSON Schema; only caret-vs-line is domain logic. */
export function parsePiApiBody(body: unknown): { api: PiApiName; params: unknown } | { error: string } {
  if (!validateBody(body)) {
    const error = validateBody.errors?.[0];
    return { error: `${error?.instancePath || "body"} ${error?.message ?? "is invalid"}` };
  }
  const { api, params } = body;
  if (api === "autocomplete.suggestions") {
    const caret = params as { line: string; cursorCol: number };
    if (caret.cursorCol > caret.line.length) return { error: "cursorCol out of range" };
  }
  return { api, params };
}
