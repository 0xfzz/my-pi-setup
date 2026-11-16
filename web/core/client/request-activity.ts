// Network feedback is owned by the host, not by individual plugins. Track
// fetches and body reads without buffering, consuming or changing their data.
const BODY_READERS = new Set(["json", "text", "blob", "arrayBuffer", "formData", "bytes"]);

/**
 * A request whose answer arrives only when the agent's turn ends: a prompt or a
 * web command posted to a session. Its pending time is the turn itself, which
 * the transcript's working line already shows; counting it would keep the
 * loading card up for the whole of every reply. Abort and every other request
 * answer at once, so they stay tracked.
 */
export function isTurnRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, "http://local").pathname;
  if (path === "/api/agent/new" || !/^\/api\/agent\/[^/]+$/.test(path)) return false;
  if ((init?.method ?? "GET").toUpperCase() !== "POST") return false;
  if (typeof init?.body !== "string") return false;
  try {
    const type = (JSON.parse(init.body) as { type?: unknown }).type;
    return type === "prompt" || type === "web_command";
  } catch {
    return false;
  }
}

export function createRequestActivity(fetcher: typeof fetch) {
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

  function observeBody(response: Response): Response {
    // Bind native methods/getters to the real Response (including bodyUsed,
    // url and clone). A proxy avoids copying or draining potentially huge files.
    return new Proxy(response, {
      get(target, key) {
        if (key === "clone") return () => observeBody(target.clone());
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (typeof key === "string" && BODY_READERS.has(key)) {
          return () => track(() => value.call(target));
        }
        return value.bind(target);
      },
    });
  }

  const trackedFetch: typeof fetch = async (input, init) => {
    if (isTurnRequest(input, init)) return fetcher(input, init);
    return observeBody(await track(() => fetcher(input, init)));
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
export const requestActivity = createRequestActivity(globalThis.fetch.bind(globalThis));
