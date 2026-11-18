// Network feedback is owned by the host, not by individual plugins. Track
// fetches and body reads without buffering, consuming or changing their data.
import { reportClientError, reportClientWarning } from "./logging.ts";

const BODY_READERS = new Set(["json", "text", "blob", "arrayBuffer", "formData", "bytes"]);

const PROTOCOL_PATH = /^\/api\/(?:agent\/[^/]+\/)?protocol$/;
const TURN_MESSAGES = new Set(["session.prompt", "web-command.dispatch"]);
const LEGACY_TURN_TYPES = new Set(["prompt", "web_command"]);

/** Old command routes are still recognised until their aliases are removed. */
function isLegacyTurn(path: string, body: { name?: unknown; type?: unknown }): boolean {
  if (path === "/api/agent/new" || !/^\/api\/agent\/[^/]+$/.test(path)) return false;
  return typeof body.type === "string" && LEGACY_TURN_TYPES.has(body.type);
}

/**
 * A request whose answer arrives only when the agent's turn ends: a protocol
 * command that starts or continues a turn. Its pending time is the turn itself,
 * which the transcript's working line already shows; counting it would keep
 * the loading card up for the whole of every reply. Every other protocol
 * message answers at once, so it stays tracked.
 */
export function isTurnRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, "http://local").pathname;
  if ((init?.method ?? "GET").toUpperCase() !== "POST") return false;
  if (typeof init?.body !== "string") return false;
  try {
    const body = JSON.parse(init.body) as { name?: unknown; type?: unknown };
    if (!PROTOCOL_PATH.test(path)) return isLegacyTurn(path, body);
    return typeof body.name === "string" && TURN_MESSAGES.has(body.name);
  } catch {
    return false;
  }
}

function requestTarget(input: RequestInfo | URL): string {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw, "http://local").pathname;
  } catch {
    return "<invalid-url>";
  }
}

export interface RequestFailureReporter {
  (level: "error" | "warn", context: string, error: unknown, fields: Record<string, unknown>): void;
}

export const reportRequestFailure: RequestFailureReporter = (level, context, error, fields) => {
  if (level === "error") reportClientError(context, error, fields);
  else reportClientWarning(context, error, fields);
};

const silentReporter: RequestFailureReporter = () => {};

export function createRequestActivity(fetcher: typeof fetch, report: RequestFailureReporter = silentReporter) {
  const listeners = new Set<() => void>();
  let pending = 0;
  const publish = () => { for (const listener of listeners) listener(); };

  async function track<T>(operation: () => Promise<T>): Promise<T> {
    pending += 1;
    publish();
    try {
      return await operation();
    } finally {
      pending -= 1;
      publish();
    }
  }

  function observeBody(response: Response, path: string, method: string): Response {
    // Bind native methods/getters to the real Response (including bodyUsed,
    // url and clone). A proxy avoids copying or draining potentially huge files.
    return new Proxy(response, {
      get(target, key) {
        if (key === "clone") return () => observeBody(target.clone(), path, method);
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (typeof key === "string" && BODY_READERS.has(key)) {
          return async () => {
            try {
              return await track(() => value.call(target));
            } catch (error) {
              report("error", "HTTP response body could not be read", error, { method, path, reader: key });
              throw error;
            }
          };
        }
        return value.bind(target);
      },
    });
  }

  const trackedFetch: typeof fetch = async (input, init) => {
    const path = requestTarget(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const perform = (): Promise<Response> => fetcher(input, init);
    try {
      const response = isTurnRequest(input, init) ? await perform() : await track(perform);
      if (!response.ok) {
        report("warn", "HTTP request returned an error status", new Error(`${method} ${path} failed with HTTP ${response.status}`), {
          method, path, status: response.status,
        });
      }
      return isTurnRequest(input, init) ? response : observeBody(response, path, method);
    } catch (error) {
      report("error", "HTTP request failed", error, { method, path });
      throw error;
    }
  };

  return {
    fetch: trackedFetch,
    getSnapshot: () => pending,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

// Capture the original before auth installs its transparent retry wrapper.
export const requestActivity = createRequestActivity(globalThis.fetch.bind(globalThis), reportRequestFailure);
