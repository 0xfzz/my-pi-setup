// Network feedback is owned by the host, not by individual plugins. Track
// fetches and body reads without buffering, consuming or changing their data.
const BODY_READERS = new Set(["json", "text", "blob", "arrayBuffer", "formData", "bytes"]);

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

  const trackedFetch: typeof fetch = async (input, init) =>
    observeBody(await track(() => fetcher(input, init)));

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
