import test from "node:test";
import assert from "node:assert/strict";
import { EXPIRY_STORAGE_KEY, createAuthClient, type AuthClientDeps, type LostReason } from "./auth.ts";

const ORIGIN = "http://pi.test";
const MINUTE = 60_000;

interface Fake {
  /** Is the access cookie currently good? */
  accessValid: boolean;
  refreshStatus: number;
  refreshCalls: number;
  calls: string[];
  clock: { now: number };
  timers: Array<{ callback: () => void; ms: number; cleared: boolean }>;
  storage: Map<string, string>;
  client: ReturnType<typeof createAuthClient>;
  lost: LostReason[];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function setup(overrides: Partial<AuthClientDeps> = {}, handler?: (fake: Fake, path: string) => Response | Promise<Response> | undefined): Fake {
  const fake: Fake = {
    accessValid: true,
    refreshStatus: 200,
    refreshCalls: 0,
    calls: [],
    clock: { now: 1_000_000 },
    timers: [],
    storage: new Map(),
    client: undefined as never,
    lost: [],
  };
  const rawFetch: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, ORIGIN);
    fake.calls.push(url.pathname);
    const custom = handler?.(fake, url.pathname);
    if (custom !== undefined) return custom;
    if (url.pathname === "/api/auth/refresh") {
      fake.refreshCalls += 1;
      await Promise.resolve();
      if (fake.refreshStatus === 200) {
        fake.accessValid = true;
        return json(200, { ok: true, accessExpiresAt: fake.clock.now + 15 * MINUTE });
      }
      if (fake.refreshStatus === -1) throw new TypeError("network down");
      return json(fake.refreshStatus, { code: "refresh_invalid" });
    }
    if (url.pathname === "/api/auth/login") return json(401, { code: "invalid_credentials" });
    return fake.accessValid ? json(200, { path: url.pathname }) : json(401, { code: "token_expired" });
  };
  fake.client = createAuthClient({
    fetch: rawFetch,
    now: () => fake.clock.now,
    origin: ORIGIN,
    storage: {
      getItem: (key) => fake.storage.get(key) ?? null,
      setItem: (key, value) => void fake.storage.set(key, value),
      removeItem: (key) => void fake.storage.delete(key),
    },
    setTimeout: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      fake.timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    random: () => 0,
    ...overrides,
  });
  fake.client.onLost((reason) => fake.lost.push(reason));
  return fake;
}

const refreshCount = (fake: Fake): number => fake.calls.filter((path) => path === "/api/auth/refresh").length;

test("requests outside the protected API pass through untouched", async () => {
  const fake = setup();
  fake.accessValid = false;
  assert.equal((await fake.client.fetch("/api/health")).status, 401, "health is not wrapped");
  assert.equal((await fake.client.fetch("/index.html")).status, 401);
  assert.equal((await fake.client.fetch("https://other.example/api/sessions")).status, 401, "other origins are never refreshed for");
  assert.equal((await fake.client.fetch("/api/auth/login", { method: "POST" })).status, 401, "a wrong password must not trigger a refresh");
  assert.equal(refreshCount(fake), 0);
});

test("a 401 refreshes once and the request is retried transparently", async () => {
  const fake = setup();
  fake.accessValid = false;
  const res = await fake.client.fetch("/api/sessions");
  assert.equal(res.status, 200);
  assert.deepEqual(fake.calls, ["/api/sessions", "/api/auth/refresh", "/api/sessions"]);
  assert.deepEqual(fake.lost, []);
});

test("many requests failing together share one refresh (no rotation storm)", async () => {
  const fake = setup();
  fake.accessValid = false;
  const results = await Promise.all(
    ["/api/sessions", "/api/plugins", "/api/agent/a", "/api/agent/b/commands", "/api/directories"].map((path) => fake.client.fetch(path)),
  );
  assert.deepEqual(results.map((res) => res.status), [200, 200, 200, 200, 200]);
  assert.equal(refreshCount(fake), 1, "single flight");
});

test("a request that failed while a refresh was landing retries without refreshing again", async () => {
  let release: () => void = () => undefined;
  const held = new Promise<Response>((resolve) => {
    release = () => resolve(json(401, { code: "token_expired" }));
  });
  let slowCalls = 0;
  const fake = setup({}, (_state, path) => {
    if (path !== "/api/slow") return undefined;
    slowCalls += 1;
    return slowCalls === 1 ? held : json(200, { path });
  });
  fake.accessValid = false;
  // The slow request leaves with the old cookie; a fast one refreshes the session meanwhile.
  const slow = fake.client.fetch("/api/slow");
  assert.equal((await fake.client.fetch("/api/sessions")).status, 200);
  assert.equal(refreshCount(fake), 1);
  release();
  assert.equal((await slow).status, 200, "retried with the fresh cookie");
  assert.equal(refreshCount(fake), 1, "and did not rotate the refresh token a second time");
});

test("a request retries only once; a second 401 is returned, not looped", async () => {
  const fake = setup({}, (_state, path) => (path === "/api/forbidden" ? json(401, { code: "unauthenticated" }) : undefined));
  const res = await fake.client.fetch("/api/forbidden");
  assert.equal(res.status, 401);
  assert.equal(refreshCount(fake), 1);
  assert.deepEqual(fake.calls.filter((p) => p === "/api/forbidden").length, 2);
});

test("a Request object is replayed from a clone", async () => {
  const fake = setup();
  fake.accessValid = false;
  const res = await fake.client.fetch(new Request(`${ORIGIN}/api/agent/new`, { method: "POST", body: JSON.stringify({ cwd: "/x" }) }));
  assert.equal(res.status, 200);
  assert.equal(fake.calls.filter((p) => p === "/api/agent/new").length, 2);
});

test("a refresh the server rejects ends the session: listeners hear it once, the 401 is returned", async () => {
  const fake = setup();
  fake.accessValid = false;
  fake.refreshStatus = 401;
  const results = await Promise.all([fake.client.fetch("/api/sessions"), fake.client.fetch("/api/plugins")]);
  assert.deepEqual(results.map((res) => res.status), [401, 401]);
  assert.deepEqual(fake.lost, ["expired"]);
  assert.equal(refreshCount(fake), 1);
  assert.equal(fake.storage.has(EXPIRY_STORAGE_KEY), false);
});

test("a refresh that fails for any other reason is not a logout and is retried later", async () => {
  for (const status of [500, 503, -1]) {
    const fake = setup();
    fake.accessValid = false;
    fake.refreshStatus = status;
    await fake.client.status().catch(() => undefined);
    const res = await fake.client.fetch("/api/sessions");
    assert.equal(res.status, 401, "the caller sees the failure");
    assert.deepEqual(fake.lost, [], `status ${status} must not drop the session`);
  }
  // The retry timer is armed once an expiry is known.
  const fake = setup({}, (_state, path) => (path === "/api/auth/status" ? json(200, { required: true, authenticated: true, accessExpiresAt: 1_000_000 + 15 * MINUTE }) : undefined));
  await fake.client.status();
  fake.refreshStatus = 503;
  fake.accessValid = false;
  await fake.client.fetch("/api/sessions");
  const retry = fake.timers.filter((t) => !t.cleared).at(-1);
  assert.equal(retry?.ms, 15_000);
});

test("the access token is refreshed ahead of expiry by a timer", async () => {
  const fake = setup({}, (_state, path) => (path === "/api/auth/status" ? json(200, { required: true, authenticated: true, accessExpiresAt: 1_000_000 + 15 * MINUTE }) : undefined));
  await fake.client.status();
  const timer = fake.timers.filter((t) => !t.cleared).at(-1);
  assert.ok(timer);
  assert.equal(timer.ms, 14 * MINUTE, "one minute before expiry (jitter pinned to 0)");
  assert.equal(fake.storage.get(EXPIRY_STORAGE_KEY), String(1_000_000 + 15 * MINUTE));

  fake.clock.now += 14 * MINUTE;
  timer.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshCount(fake), 1);
  const next = fake.timers.filter((t) => !t.cleared).at(-1);
  assert.notEqual(next, timer, "the next refresh is already scheduled");
  assert.equal(fake.client.expiresAt(), fake.clock.now + 15 * MINUTE);
});

test("ensureFresh does nothing while the token has life, and refreshes when it is nearly gone", async () => {
  const fake = setup({}, (_state, path) => (path === "/api/auth/status" ? json(200, { required: true, authenticated: true, accessExpiresAt: 1_000_000 + 15 * MINUTE }) : undefined));
  await fake.client.status();
  assert.equal(await fake.client.ensureFresh(), "ok");
  assert.equal(refreshCount(fake), 0);
  fake.clock.now += 14.5 * MINUTE;
  assert.equal(await fake.client.ensureFresh(), "ok");
  assert.equal(refreshCount(fake), 1);
});

test("a sibling tab's refresh is adopted instead of rotating the token again", async () => {
  const locked: string[] = [];
  let sessionCalls = 0;
  const fake = setup({
    locks: {
      request: async (name, callback) => {
        locked.push(name);
        return callback();
      },
    },
  }, (_state, path) => {
    if (path === "/api/auth/status") return json(200, { required: true, authenticated: true, accessExpiresAt: 1_000_000 + MINUTE });
    if (path === "/api/sessions") {
      sessionCalls += 1;
      return sessionCalls === 1 ? json(401, { code: "token_expired" }) : json(200, {});
    }
    return undefined;
  });
  await fake.client.status();
  // Another tab refreshed (and published the new expiry) before this tab got the lock.
  fake.storage.set(EXPIRY_STORAGE_KEY, String(fake.clock.now + 15 * MINUTE));
  const res = await fake.client.fetch("/api/sessions");
  assert.equal(res.status, 200, "retried with the cookie the sibling tab set");
  assert.equal(refreshCount(fake), 0, "no second rotation");
  assert.deepEqual(locked, ["pi-web-auth-refresh"]);
  assert.equal(fake.client.expiresAt(), fake.clock.now + 15 * MINUTE);
});

test("recoverStream reconnects only when the cause is an expired session", async () => {
  let status = { required: true, authenticated: false };
  const fake = setup({}, (_state, path) => (path === "/api/auth/status" ? json(200, status) : undefined));
  assert.equal(await fake.client.recoverStream(), true);
  assert.equal(refreshCount(fake), 1);

  status = { required: true, authenticated: true };
  assert.equal(await fake.client.recoverStream(), false, "signed in: the failure is something else");
  status = { required: false, authenticated: true };
  assert.equal(await fake.client.recoverStream(), false);
  assert.equal(refreshCount(fake), 1, "no pointless rotations");

  status = { required: true, authenticated: false };
  fake.refreshStatus = 401;
  assert.equal(await fake.client.recoverStream(), false);
  assert.deepEqual(fake.lost, ["expired"]);
});

test("login maps the server's answers to messages and a lockout delay", async () => {
  const answers: Response[] = [
    json(200, { ok: true, accessExpiresAt: 1_000_000 + 15 * MINUTE }),
    json(401, { code: "invalid_credentials" }),
    json(429, { code: "rate_limited", retryAfterSeconds: 42 }),
    json(500, { error: "boom" }),
  ];
  const fake = setup({}, (_state, path) => (path === "/api/auth/login" ? answers.shift() : undefined));
  assert.deepEqual(await fake.client.login("pw"), { ok: true });
  assert.equal(fake.client.expiresAt(), 1_000_000 + 15 * MINUTE);
  assert.deepEqual(await fake.client.login("pw"), { ok: false, error: "Wrong password." });
  assert.deepEqual(await fake.client.login("pw"), { ok: false, error: "Too many attempts.", retryAfterSeconds: 42 });
  assert.deepEqual(await fake.client.login("pw"), { ok: false, error: "boom" });
});

test("logout tells listeners the user signed out and stops the refresh timer", async () => {
  const fake = setup({}, (_state, path) => (path === "/api/auth/status" ? json(200, { required: true, authenticated: true, accessExpiresAt: 1_000_000 + 15 * MINUTE }) : path === "/api/auth/logout" ? json(200, { ok: true }) : undefined));
  await fake.client.status();
  await fake.client.logout();
  assert.deepEqual(fake.lost, ["signed_out"]);
  assert.equal(fake.client.expiresAt(), 0);
  assert.ok(fake.timers.every((t) => t.cleared));
});
