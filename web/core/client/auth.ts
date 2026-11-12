// Client side of the web password: keeps the session alive so no endpoint ever fails
// just because a token was not refreshed.
//
// The server holds the tokens in HttpOnly cookies; the client never sees them. What it
// does see is when the access token expires (`accessExpiresAt`), and it keeps the
// session fresh three ways, each safe to run concurrently with the others:
//
//   1. Proactively: a timer refreshes a minute before expiry, and a refresh also runs
//      when the tab becomes visible or the network returns (timers freeze in the background).
//   2. Reactively: any /api request that comes back 401 triggers ONE refresh and a single
//      retry of that request. Many 401s at once share the same in-flight refresh; a request
//      that failed because a refresh was still landing retries without refreshing again.
//   3. Across tabs: tabs share cookies, so they take a Web Lock around the refresh and
//      announce the new expiry through localStorage; a tab that finds its sibling already
//      refreshed adopts that instead of rotating the token a second time.
//
// A refresh that the server rejects (401) means the session is really over: listeners are
// told, and the app shows the login screen. A refresh that fails any other way (offline,
// 5xx) is NOT a logout — it is retried later and the user keeps their session.

export type RefreshOutcome = "ok" | "denied" | "unavailable";

export interface AuthStatus {
  required: boolean;
  authenticated: boolean;
  accessExpiresAt?: number;
  /** The server has a password file it cannot read and refuses everything. */
  unavailable?: boolean;
}

export type LoginResult =
  | { ok: true }
  | { ok: false; error: string; retryAfterSeconds?: number };

export type LostReason = "expired" | "signed_out";

export interface AuthClientDeps {
  /** The browser's original fetch (before this client wraps it). */
  fetch: typeof fetch;
  now: () => number;
  /** Origin used to decide whether a request is ours. */
  origin: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  locks?: { request<T>(name: string, callback: () => Promise<T>): Promise<T> };
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  random?: () => number;
}

export interface AuthClient {
  /** fetch with transparent refresh-and-retry for /api requests. */
  fetch: typeof fetch;
  status(): Promise<AuthStatus>;
  login(password: string): Promise<LoginResult>;
  logout(): Promise<void>;
  /** Refresh now. `knownExpiry` lets a caller say which token it saw fail. */
  refresh(knownExpiry?: number): Promise<RefreshOutcome>;
  /** Refresh only if the access token expires within `marginMs` (tab woke up, network is back). */
  ensureFresh(marginMs?: number): Promise<RefreshOutcome>;
  /**
   * For an event stream that died: if the cause is an expired session, recover it.
   * True means "reconnect now". False means the failure is something else — leave it alone.
   */
  recoverStream(): Promise<boolean>;
  /** A sibling tab refreshed (storage event). */
  adoptExpiry(expiresAt: number): void;
  /** The session cannot be recovered; show the login screen. Returns an unsubscribe function. */
  onLost(listener: (reason: LostReason) => void): () => void;
  expiresAt(): number;
}

export const EXPIRY_STORAGE_KEY = "pi-web.auth.accessExpiresAt";
const LOCK_NAME = "pi-web-auth-refresh";
/** Refresh this long before the access token lapses. */
const REFRESH_LEAD_MS = 60_000;
const MIN_DELAY_MS = 5_000;
const MAX_DELAY_MS = 60 * 60_000;
const RETRY_DELAYS_MS = [15_000, 30_000, 60_000];
/** A sibling tab's refresh counts only if it leaves at least this much life. */
const ADOPT_MIN_REMAINING_MS = 5_000;

function pathOf(input: RequestInfo | URL, origin: string): string | null {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, origin);
    return url.origin === origin ? url.pathname : null;
  } catch {
    return null;
  }
}

/** Requests the refresh-and-retry applies to: our API, minus liveness and the auth routes themselves. */
function isProtectedApi(path: string | null): boolean {
  return path !== null && path.startsWith("/api/") && !path.startsWith("/api/auth/") && path !== "/api/health";
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await res.json();
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createAuthClient(deps: AuthClientDeps): AuthClient {
  const setTimer = deps.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const random = deps.random ?? Math.random;
  const listeners = new Set<(reason: LostReason) => void>();

  let expiresAt = 0;
  /** Bumped whenever a refresh or login lands; lets a late 401 know a fresher cookie already exists. */
  let generation = 0;
  let inflight: Promise<RefreshOutcome> | null = null;
  let timer: unknown = null;
  let retryIndex = 0;

  const store = (value: number): void => {
    try {
      if (value > 0) deps.storage?.setItem(EXPIRY_STORAGE_KEY, String(value));
      else deps.storage?.removeItem(EXPIRY_STORAGE_KEY);
    } catch {
      // Private mode or quota: cross-tab hints are best effort.
    }
  };

  const clearSchedule = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const schedule = (delayMs?: number): void => {
    clearSchedule();
    if (expiresAt <= 0) return;
    const wanted = delayMs ?? expiresAt - deps.now() - REFRESH_LEAD_MS - random() * 10_000;
    const delay = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, wanted));
    timer = setTimer(() => {
      timer = null;
      void refresh(expiresAt);
    }, delay);
  };

  const setExpiry = (value: number, publish: boolean): void => {
    expiresAt = value;
    if (publish) store(value);
    schedule();
  };

  const lost = (reason: LostReason): void => {
    clearSchedule();
    expiresAt = 0;
    store(0);
    generation += 1;
    for (const listener of listeners) listener(reason);
  };

  const requestRefresh = async (): Promise<RefreshOutcome> => {
    let res: Response;
    try {
      res = await deps.fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        credentials: "same-origin",
      });
    } catch {
      return "unavailable";
    }
    if (res.status === 200) {
      const body = await readJson(res);
      if (typeof body.accessExpiresAt === "number") {
        generation += 1;
        retryIndex = 0;
        setExpiry(body.accessExpiresAt, true);
        return "ok";
      }
      return "unavailable";
    }
    // 401 is the server saying the refresh token is gone, expired or burned: the session is over.
    if (res.status === 401) {
      lost("expired");
      return "denied";
    }
    return "unavailable";
  };

  const doRefresh = async (knownExpiry: number | undefined): Promise<RefreshOutcome> => {
    const attempt = async (): Promise<RefreshOutcome> => {
      // Another tab may have refreshed while we waited for the lock.
      if (knownExpiry !== undefined && deps.storage !== undefined) {
        const stored = Number(deps.storage.getItem(EXPIRY_STORAGE_KEY) ?? 0);
        if (stored > knownExpiry && stored - deps.now() > ADOPT_MIN_REMAINING_MS) {
          generation += 1;
          setExpiry(stored, false);
          return "ok";
        }
      }
      return requestRefresh();
    };
    const outcome = deps.locks !== undefined ? await deps.locks.request(LOCK_NAME, attempt) : await attempt();
    if (outcome === "unavailable") {
      // Not a logout: try again soon so the session is fresh by the time the network is back.
      const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)] ?? 60_000;
      retryIndex += 1;
      if (expiresAt > 0) schedule(delay);
    }
    return outcome;
  };

  // Single flight: every caller that needs a refresh while one is running shares it.
  function refresh(knownExpiry?: number): Promise<RefreshOutcome> {
    inflight ??= doRefresh(knownExpiry).finally(() => {
      inflight = null;
    });
    return inflight;
  }

  const status = async (): Promise<AuthStatus> => {
    const res = await deps.fetch("/api/auth/status", { credentials: "same-origin" });
    const body = (await readJson(res)) as unknown as AuthStatus;
    if (body.authenticated && typeof body.accessExpiresAt === "number") setExpiry(body.accessExpiresAt, true);
    return body;
  };

  const wrappedFetch: typeof fetch = async (input, init) => {
    if (!isProtectedApi(pathOf(input, deps.origin))) return deps.fetch(input, init);
    const startedGeneration = generation;
    const startedExpiry = expiresAt;
    // A Request body can be sent once; keep a clone for the retry.
    const retryInput = input instanceof Request ? input.clone() : input;
    const response = await deps.fetch(input, init);
    if (response.status !== 401) return response;

    const outcome = generation !== startedGeneration ? "ok" : await refresh(startedExpiry > 0 ? startedExpiry : undefined);
    if (outcome !== "ok") return response;
    return deps.fetch(retryInput, init);
  };

  return {
    fetch: wrappedFetch,

    status,

    async login(password) {
      let res: Response;
      try {
        res = await deps.fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
          credentials: "same-origin",
        });
      } catch {
        return { ok: false, error: "Cannot reach the server." };
      }
      const body = await readJson(res);
      if (res.status === 200 && typeof body.accessExpiresAt === "number") {
        generation += 1;
        retryIndex = 0;
        setExpiry(body.accessExpiresAt, true);
        return { ok: true };
      }
      if (res.status === 429) {
        const retryAfterSeconds = typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : 60;
        return { ok: false, error: "Too many attempts.", retryAfterSeconds };
      }
      if (res.status === 401) return { ok: false, error: "Wrong password." };
      return { ok: false, error: typeof body.error === "string" ? body.error : `Sign-in failed (HTTP ${res.status}).` };
    },

    async logout() {
      try {
        await deps.fetch("/api/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          credentials: "same-origin",
        });
      } finally {
        lost("signed_out");
      }
    },

    refresh,

    async ensureFresh(marginMs = REFRESH_LEAD_MS) {
      if (expiresAt <= 0 || expiresAt - deps.now() > marginMs) return "ok";
      return refresh(expiresAt);
    },

    async recoverStream() {
      let current: AuthStatus;
      try {
        current = await status();
      } catch {
        return false;
      }
      // Authenticated, or no password at all: the stream failed for some other reason.
      if (!current.required || current.authenticated || current.unavailable === true) return false;
      return (await refresh()) === "ok";
    },

    adoptExpiry(value) {
      if (value > expiresAt) {
        generation += 1;
        setExpiry(value, false);
      }
    },

    onLost(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    expiresAt: () => expiresAt,
  };
}

/** The app's single client, wired to the real browser. */
function createBrowserAuth(): AuthClient {
  const nativeFetch = window.fetch.bind(window);
  const client = createAuthClient({
    fetch: nativeFetch,
    now: () => Date.now(),
    origin: window.location.origin,
    storage: window.localStorage,
    ...(typeof navigator !== "undefined" && "locks" in navigator
      ? { locks: navigator.locks as unknown as NonNullable<AuthClientDeps["locks"]> }
      : {}),
  });

  window.fetch = client.fetch;

  // Timers are throttled or frozen in background tabs: catch up when the tab is back.
  const wake = (): void => {
    void client.ensureFresh();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wake();
  });
  window.addEventListener("online", wake);
  window.addEventListener("focus", wake);
  window.addEventListener("storage", (event) => {
    if (event.key === EXPIRY_STORAGE_KEY && event.newValue !== null) client.adoptExpiry(Number(event.newValue));
  });
  return client;
}

let browserAuth: AuthClient | undefined;

/** Installs the fetch wrapper on first use; call before the first request. */
export function getAuth(): AuthClient {
  browserAuth ??= createBrowserAuth();
  return browserAuth;
}
