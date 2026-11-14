// The one JSON client a plugin's UI uses to reach its own backend.
//
// Every plugin page had grown its own copy of "fetch, parse, decide whether
// this is a failure", each with a slightly different result shape. This is the
// shared one: a discriminated result, never a throw, so a caller can tell a
// network failure from a 403 from a plugin's own error code.

export interface ApiFailure {
  ok: false;
  /** The server's error code, or `network` when it never answered. */
  code: string;
  message: string;
  /** HTTP status, or 0 when no response arrived. */
  status: number;
}

export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

export interface JsonRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
}

const NETWORK_FAILURE: ApiFailure = {
  ok: false,
  code: "network",
  message: "the web server did not answer",
  status: 0,
};

/** A JSON object body, or an empty one when the server sent none. */
async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function failureFrom(response: Response, body: Record<string, unknown>): ApiFailure {
  return {
    ok: false,
    code: typeof body.code === "string" ? body.code : "error",
    message: typeof body.error === "string" ? body.error : `request failed (HTTP ${response.status})`,
    status: response.status,
  };
}

/**
 * One JSON round trip. A thrown `fetch` (offline, aborted, CORS) is a
 * `network` failure; a non-2xx response carries the server's own `error` and
 * `code`. The parsed body is returned as `T`: the response shape is the wire
 * contract both sides import, so the cast is the single JSON boundary.
 */
export async function requestJson<T>({ url, method = "GET", body, headers }: JsonRequest): Promise<ApiResult<T>> {
  const requestHeaders: Record<string, string> = { Accept: "application/json", ...headers };
  const init: RequestInit = { method, headers: requestHeaders };
  if (body !== undefined) {
    requestHeaders["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    return NETWORK_FAILURE;
  }
  const parsed = await readJsonObject(response);
  if (!response.ok) return failureFrom(response, parsed);
  return { ok: true, data: parsed as T };
}

/** `GET url` as JSON. */
export function getJson<T>(url: string, headers?: Record<string, string>): Promise<ApiResult<T>> {
  return requestJson<T>({ url, ...(headers !== undefined ? { headers } : {}) });
}

/** `POST url` with a JSON body. */
export function postJson<T>(url: string, body?: unknown): Promise<ApiResult<T>> {
  return requestJson<T>({ url, method: "POST", ...(body !== undefined ? { body } : {}) });
}
