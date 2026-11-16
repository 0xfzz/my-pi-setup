import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from "fastify";

/** Register only the complement of real methods, rejecting before body consumption. */
export function registerMethodFallback(app: FastifyInstance, options: {
  path: string;
  methods: readonly string[];
  refuse: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}): void {
  const methods = app.supportedMethods.filter(method => !options.methods.includes(method)) as HTTPMethods[];
  app.route({ method: methods, url: options.path, onRequest: options.refuse, handler: options.refuse });
}
