import { Ajv, type ValidateFunction } from "ajv";
import { HTTP_AJV_OPTIONS } from "../../../lib/http-schema-policy.ts";

// The same engine/options as Fastify, for HTTP-independent protocol entry points.
// Keep this under web/ so either package's declared install can resolve Ajv.
const compiler = new Ajv(HTTP_AJV_OPTIONS);

export function compileHttpSchema<T>(schema: Record<string, unknown>): ValidateFunction<T> {
  return compiler.compile<T>(schema);
}
