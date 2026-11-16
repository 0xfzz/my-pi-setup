// Small HTTP helpers shared by the remaining raw-response paths.
//
// The request-body reader and the JSON writer that used to live here are gone:
// Fastify parses bodies and serializes replies now. `sendJson` survives only for
// the transitional `/*` delegate's own answers (the API gate and 404s).

import type { ServerResponse } from "node:http";

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}
