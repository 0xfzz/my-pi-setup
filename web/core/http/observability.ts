// Framework request diagnostics (PRD M14). Fastify already assigns a request
// id and binds a child logger per request; this module only chooses how quiet
// that logger is and which request fields may reach it. Startup/process
// messages and the plugin action audit stay where they were.
import { Writable } from "node:stream";
import type { FastifyLoggerOptions, FastifyRequest } from "fastify";
import type { LoggerOptions as PinoLoggerOptions } from "pino";
import { WEB_LOG_REDACT_PATHS } from "./log-redaction.ts";

/** Framework request logs default to warnings/errors; the direct server entry raises this. */
export const HTTP_LOG_LEVEL = "warn";

/**
 * The only request fields the framework may log. The query string is dropped
 * because a graph bootstrap or producer token can travel there; cookies,
 * authorization headers and bodies are not part of the default serializer.
 */
export function requestLogFields(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: request.url.split("?")[0],
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

/**
 * Structured logging with request ids and credential-safe request fields. The
 * `warn` level keeps the current quiet output (no per-success request lines)
 * while warnings/errors stay structured; the serializer still strips the query
 * so a future level change cannot leak a bootstrap/producer token.
 */
export function httpLoggerOptions(overrides: Partial<FastifyLoggerOptions & PinoLoggerOptions> = {}): FastifyLoggerOptions & PinoLoggerOptions {
  return {
    level: HTTP_LOG_LEVEL,
    redact: { paths: WEB_LOG_REDACT_PATHS, censor: "[REDACTED]" },
    serializers: { req: requestLogFields },
    ...overrides,
  };
}

/** Forward whole lines from a byte stream into an existing line-oriented sink. */
export function lineLogStream(sink: (line: string) => void): Writable {
  let pending = "";
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line !== "") sink(line);
      callback();
    },
  });
}
