import type { FastifyInstance, FastifyRequest } from "fastify";

const parseErrors = new WeakMap<FastifyRequest, Error>();

/** Parse once before schema validation, but let each endpoint keep its error order. */
export function registerLenientJsonParser(app: FastifyInstance): void {
  app.addHook("preValidation", async request => {
    if (request.body === undefined && !parseErrors.has(request)) request.body = {};
  });
  app.addContentTypeParser("*", { parseAs: "string" }, (request, raw, done) => {
    try {
      done(null, typeof raw === "string" && raw !== "" ? JSON.parse(raw) : {});
    } catch {
      parseErrors.set(request, new SyntaxError("Invalid JSON body"));
      done(null, undefined);
    }
  });
}

export function parsedJsonBody(request: FastifyRequest): unknown {
  const error = parseErrors.get(request);
  if (error) throw error;
  return request.body === undefined ? {} : request.body;
}
