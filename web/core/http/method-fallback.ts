import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from "fastify";

/**
 * Answer 405 for a registered path used with a method it does not support.
 *
 * A parameter route such as `/api/sessions/:id` also matches the trailing-slash
 * URL `/api/sessions/` with an empty `id`. That URL names no resource, so an
 * empty parameter is a plain 404, not a method refusal.
 */
export function registerMethodFallback(app: FastifyInstance, options: {
  path: string;
  methods: readonly string[];
  refuse: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}): void {
  const methods = app.supportedMethods.filter(method => !options.methods.includes(method)) as HTTPMethods[];
  const refuse = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!hasEmptyParam(request.params)) return options.refuse(request, reply);
    await reply.code(404).header("cache-control", "no-store").send({ error: "not found" });
  };
  app.route({ method: methods, url: options.path, onRequest: refuse, handler: refuse });
}

function hasEmptyParam(params: unknown): boolean {
  return typeof params === "object" && params !== null && Object.values(params).includes("");
}
