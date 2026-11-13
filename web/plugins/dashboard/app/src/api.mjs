/**
 * Same-origin API client + event coalescing.
 *
 * The client only reads. Every request is injected (`fetchImpl`) so tests can
 * exercise encoding, error mapping and race handling without a server.
 */

export class ApiError extends Error {
  constructor(message, status = 0, cause = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.cause = cause;
  }
}

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function createApi({ fetchImpl = (...args) => fetch(...args), base = "" } = {}) {
  async function getJson(path) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: "GET",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
    } catch (error) {
      throw new ApiError("Dashboard API is unreachable", 0, error);
    }
    if (!response || !response.ok) {
      let message = `Request failed (${response?.status ?? "network"})`;
      let body = null;
      try {
        body = await response.json();
        if (body && typeof body.error === "string" && body.error) message = body.error;
      } catch {
        // ignore non-JSON error bodies
      }
      throw new ApiError(message, Number(response?.status) || 0, body);
    }
    try {
      return await response.json();
    } catch (error) {
      throw new ApiError("Dashboard API returned invalid JSON", Number(response.status) || 0, error);
    }
  }

  return {
    sessions: () => getJson("/api/sessions"),
    session: (id) => getJson(`/api/session${query({ id })}`),
    artifact: (session, id, version) => getJson(`/api/artifact${query({ session, id, version })}`),
    health: () => getJson("/api/sessions"),
  };
}

/**
 * Coalesce bursts of `changed` events into one refresh. `schedule` defaults to
 * setTimeout so tests can inject a deterministic queue.
 */
export function createChangeCoalescer(onChange, { delay = 220, schedule = setTimeout, clear = clearTimeout } = {}) {
  let timer = null;
  let dirty = false;
  function flush() {
    timer = null;
    if (!dirty) return;
    dirty = false;
    onChange();
  }
  function trigger() {
    dirty = true;
    if (timer !== null) return;
    timer = schedule(flush, delay);
  }
  function cancel() {
    dirty = false;
    if (timer !== null) clear(timer);
    timer = null;
  }
  return { trigger, cancel, isPending: () => timer !== null };
}

/** Parse one SSE payload; ignores malformed/unknown messages. */
export function parseChangeEvent(data) {
  try {
    const parsed = JSON.parse(String(data));
    return Boolean(parsed && parsed.type === "changed");
  } catch {
    return false;
  }
}
