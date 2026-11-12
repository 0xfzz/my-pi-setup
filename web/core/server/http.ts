// Small HTTP helpers shared by the server and its route table.

import type { IncomingMessage, ServerResponse } from "node:http";

// Prompts can carry base64 images (downscaled client-side, ~6 MB each).
const MAX_BODY_BYTES = 60_000_000;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/** Read and parse a JSON request body; {} for an empty body, throws on oversize or bad JSON. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
}