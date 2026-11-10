import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "./main.ts";
import { clearSessionsForTests, registerSession, type SessionCore } from "./sessions.ts";
import { writeWebPassword } from "../../lib/web-auth/config.ts";
import { WebAuthService } from "../../lib/web-auth/service.ts";
import type { AuthHttpOptions } from "./auth.ts";

const PASSWORD = "correct horse battery";

test.afterEach(() => {
  clearSessionsForTests();
});

interface Harness {
  baseUrl: string;
  auth: WebAuthService;
  configPath: string;
  bridgeToken: string;
  setNow: (ms: number) => void;
}

async function withProtectedServer(
  fn: (h: Harness) => Promise<void>,
  authHttp: AuthHttpOptions = {},
  serviceOptions: Partial<ConstructorParameters<typeof WebAuthService>[0]> = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-auth-http-"));
  const configPath = join(dir, "web-auth.json");
  const config = await writeWebPassword(PASSWORD, configPath);
  let now = Date.now();
  const auth = new WebAuthService({ configPath, now: () => now, ...serviceOptions });
  const handle = await startWebServer({ port: 0, host: "127.0.0.1", auth, authHttp });
  try {
    await fn({
      baseUrl: `http://127.0.0.1:${handle.port}`,
      auth,
      configPath,
      bridgeToken: config.bridgeToken,
      setNow: (ms) => {
        now = ms;
      },
    });
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A minimal browser cookie jar: the last Set-Cookie per name wins, Max-Age=0 deletes. */
class Jar {
  readonly cookies = new Map<string, string>();
  readonly paths = new Map<string, string>();
  absorb(res: Response): string[] {
    const raw = res.headers.getSetCookie();
    for (const line of raw) {
      const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
      const index = pair.indexOf("=");
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      const maxAge = attributes.find((a) => a.toLowerCase().startsWith("max-age="));
      const path = attributes.find((a) => a.toLowerCase().startsWith("path="));
      if (maxAge?.toLowerCase() === "max-age=0" || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
      if (path !== undefined) this.paths.set(name, path.slice(5));
    }
    return raw;
  }
  header(forPath: string): string {
    return [...this.cookies]
      .filter(([name]) => forPath.startsWith(this.paths.get(name) ?? "/"))
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

async function call(
  h: Harness,
  jar: Jar,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const cookie = jar.header(path);
  const res = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie !== "" ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  jar.absorb(res);
  return res;
}

const login = (h: Harness, jar: Jar, password = PASSWORD) => call(h, jar, "POST", "/api/auth/login", { password });

test("with a password set, the API is closed but liveness and the client shell stay public", async () => {
  await withProtectedServer(async (h) => {
    const jar = new Jar();
    assert.equal((await call(h, jar, "GET", "/api/health")).status, 200);
    assert.equal((await call(h, jar, "GET", "/")).status, 200, "the SPA must load to show the login screen");

    for (const [method, path] of [
      ["GET", "/api/sessions"],
      ["GET", "/api/plugins"],
      ["GET", "/api/directories"],
      ["POST", "/api/agent/new"],
      ["GET", "/api/agent/x/events"],
      ["POST", "/api/plugins/action"],
      ["GET", "/api/definitely-not-a-route"],
    ] as const) {
      const res = await call(h, jar, method, path, method === "POST" ? {} : undefined);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.headers.get("www-authenticate"), 'Bearer realm="pi-web"');
      assert.equal(((await res.json()) as { code: string }).code, "unauthenticated");
    }

    const status = (await (await call(h, jar, "GET", "/api/auth/status")).json()) as Record<string, unknown>;
    assert.deepEqual(status, { required: true, authenticated: false });

    const headers = (await call(h, jar, "GET", "/api/health")).headers;
    assert.equal(headers.get("x-content-type-options"), "nosniff");
    assert.equal(headers.get("x-frame-options"), "DENY");
  });
});

test("login sets HttpOnly SameSite=Strict cookies, the refresh cookie scoped to /api/auth", async () => {
  await withProtectedServer(async (h) => {
    const jar = new Jar();
    const res = await login(h, jar);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(typeof body.accessExpiresAt, "number");
    assert.equal(body.accessToken, undefined, "tokens stay out of page-readable JSON");
    assert.equal(body.refreshToken, undefined);

    const lines = res.headers.getSetCookie();
    const access = lines.find((line) => line.startsWith("pi_web_at="));
    const refresh = lines.find((line) => line.startsWith("pi_web_rt="));
    assert.ok(access && refresh);
    for (const line of [access, refresh]) {
      assert.match(line, /; HttpOnly/);
      assert.match(line, /; SameSite=Strict/);
      assert.doesNotMatch(line, /; Secure/, "plain http on loopback");
    }
    assert.match(access, /; Path=\/;/);
    assert.match(refresh, /; Path=\/api\/auth;/);
    assert.match(access, /Max-Age=(899|900)/, "the cookie lives as long as the 15 minute access token");

    assert.equal((await call(h, jar, "GET", "/api/sessions")).status, 200);
    assert.deepEqual(await (await call(h, jar, "GET", "/api/auth/status")).json(), {
      required: true,
      authenticated: true,
      accessExpiresAt: body.accessExpiresAt,
    });
    assert.equal(jar.header("/api/sessions").includes("pi_web_rt"), false, "the refresh cookie is not sent to normal routes");
  });
});

test("cookies are Secure behind an https origin or proxy", async () => {
  await withProtectedServer(async (h) => {
    const viaOrigin = await call(h, new Jar(), "POST", "/api/auth/login", { password: PASSWORD }, { Origin: h.baseUrl.replace("http", "https"), "Sec-Fetch-Site": "same-origin" });
    assert.equal(viaOrigin.status, 200);
    assert.ok(viaOrigin.headers.getSetCookie().every((line) => line.includes("; Secure")));

    const viaProxy = await call(h, new Jar(), "POST", "/api/auth/login", { password: PASSWORD }, { "X-Forwarded-Proto": "https" });
    assert.ok(viaProxy.headers.getSetCookie().every((line) => line.includes("; Secure")));
  });
});

test("a wrong password is a 401 and repeated guesses are rate limited", async () => {
  await withProtectedServer(async (h) => {
    const jar = new Jar();
    for (let i = 0; i < 5; i++) {
      const res = await login(h, jar, "wrong password!!");
      assert.equal(res.status, 401);
      assert.equal(((await res.json()) as { code: string }).code, "invalid_credentials");
    }
    const locked = await login(h, jar);
    assert.equal(locked.status, 429, "even the right password waits out the lockout");
    assert.ok(Number(locked.headers.get("retry-after")) > 0);
    assert.equal(jar.cookies.size, 0);
  });
});

test("login rejects malformed bodies and oversized bodies before doing any work", async () => {
  await withProtectedServer(async (h) => {
    const jar = new Jar();
    assert.equal((await call(h, jar, "POST", "/api/auth/login", {})).status, 400);
    assert.equal((await call(h, jar, "POST", "/api/auth/login", { password: 12 })).status, 400);
    assert.equal((await call(h, jar, "POST", "/api/auth/login", { password: "x".repeat(10_000) })).status, 400);
    assert.equal((await call(h, jar, "GET", "/api/auth/login")).status, 405);
  });
});

test("an expired access token is a distinct 401, and refresh restores access with rotated cookies", async () => {
  await withProtectedServer(async (h) => {
    const jar = new Jar();
    const start = Date.now();
    h.setNow(start);
    await login(h, jar);
    const firstRefresh = jar.cookies.get("pi_web_rt");

    h.setNow(start + 16 * 60_000);
    const expired = await call(h, jar, "GET", "/api/sessions");
    assert.equal(expired.status, 401);
    assert.equal(((await expired.json()) as { code: string }).code, "token_expired");

    const refreshed = await call(h, jar, "POST", "/api/auth/refresh", {});
    assert.equal(refreshed.status, 200);
    assert.notEqual(jar.cookies.get("pi_web_rt"), firstRefresh, "the refresh cookie rotates");
    assert.equal((await call(h, jar, "GET", "/api/sessions")).status, 200);
  });
});

test("concurrent refreshes (several tabs, parallel 401s) never log the user out", async () => {
  await withProtectedServer(async (h) => {
    const jar = new Jar();
    const start = Date.now();
    h.setNow(start);
    await login(h, jar);
    h.setNow(start + 16 * 60_000);

    // Five requests present the same refresh cookie at once.
    const cookie = jar.header("/api/auth/refresh");
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(`${h.baseUrl}/api/auth/refresh`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{}" }),
      ),
    );
    assert.deepEqual(results.map((res) => res.status), [200, 200, 200, 200, 200]);
    for (const res of results) jar.absorb(res);
    // Whichever response the browser applied last, the session still works.
    assert.equal((await call(h, jar, "GET", "/api/sessions")).status, 200);
    assert.equal((await call(h, jar, "POST", "/api/auth/refresh", {})).status, 200, "and keeps refreshing");
  });
});

test("replaying a stolen, already-rotated refresh token signs the session out", async () => {
  await withProtectedServer(async (h) => {
    const jar = new Jar();
    const start = Date.now();
    h.setNow(start);
    await login(h, jar);
    const stolen = jar.header("/api/auth/refresh");
    assert.equal((await call(h, jar, "POST", "/api/auth/refresh", {})).status, 200);

    h.setNow(start + 60_000);
    const replay = await fetch(`${h.baseUrl}/api/auth/refresh`, { method: "POST", headers: { Cookie: stolen, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(replay.status, 401);
    assert.equal(((await replay.json()) as { code: string }).code, "refresh_reuse");
    assert.equal((await call(h, jar, "GET", "/api/sessions")).status, 401, "the legitimate session is revoked too");
  });
});

test("logout revokes the session at once, clears cookies and cuts open event streams", async () => {
  registerSession(fakeCore("stream-session"), "/tmp/project");
  await withProtectedServer(async (h) => {
    const jar = new Jar();
    await login(h, jar);
    const accessBefore = jar.cookies.get("pi_web_at");

    // An open SSE stream, authenticated by the cookie.
    const closed = new Promise<void>((resolveClosed) => {
      const req = httpRequest(
        `${h.baseUrl}/api/agent/stream-session/events`,
        { headers: { Cookie: jar.header("/api/agent/stream-session/events"), Accept: "text/event-stream" } },
        (res) => {
          assert.equal(res.statusCode, 200);
          res.on("data", () => undefined);
          res.on("close", () => resolveClosed());
          res.on("error", () => undefined);
        },
      );
      req.on("error", () => resolveClosed());
      req.end();
    });

    const out = await call(h, jar, "POST", "/api/auth/logout", {});
    assert.equal(out.status, 200);
    assert.equal(jar.cookies.size, 0);
    await closed;

    // The old access token no longer works even though it has not expired.
    const replay = await fetch(`${h.baseUrl}/api/sessions`, { headers: { Cookie: `pi_web_at=${accessBefore}` } });
    assert.equal(replay.status, 401);
    assert.equal(((await replay.json()) as { code: string }).code, "session_revoked");
  });
});

test("returnTokens gives API clients Bearer tokens and a body-based refresh", async () => {
  await withProtectedServer(async (h) => {
    const jar = new Jar();
    const res = await call(h, jar, "POST", "/api/auth/login", { password: PASSWORD, returnTokens: true });
    const tokens = (await res.json()) as { accessToken: string; refreshToken: string };
    assert.equal(res.headers.getSetCookie().length, 0, "token mode sets no cookies");

    const ok = await fetch(`${h.baseUrl}/api/sessions`, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
    assert.equal(ok.status, 200);
    const asRefresh = await fetch(`${h.baseUrl}/api/sessions`, { headers: { Authorization: `Bearer ${tokens.refreshToken}` } });
    assert.equal(asRefresh.status, 401, "a refresh token is not an access token");

    const next = await fetch(`${h.baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    assert.equal(next.status, 200);
    const rotated = (await next.json()) as { accessToken: string; refreshToken: string };
    assert.notEqual(rotated.refreshToken, tokens.refreshToken);
    assert.equal((await fetch(`${h.baseUrl}/api/sessions`, { headers: { Authorization: `Bearer ${rotated.accessToken}` } })).status, 200);
  });
});

test("cookie-authenticated writes from another site are refused (CSRF)", async () => {
  await withProtectedServer(async (h) => {
    const jar = new Jar();
    await login(h, jar);
    const evil = { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" };
    assert.equal((await call(h, jar, "POST", "/api/agent/new", { cwd: "/nonexistent-dir-xyz" }, evil)).status, 403);
    assert.equal((await call(h, jar, "POST", "/api/auth/logout", {}, evil)).status, 403);
    assert.equal((await call(h, jar, "POST", "/api/auth/refresh", {}, evil)).status, 403);
    assert.equal((await call(h, new Jar(), "POST", "/api/auth/login", { password: PASSWORD }, evil)).status, 403, "login CSRF");

    // Without Sec-Fetch-Site, Origin must match Host.
    const noFetchMeta = await call(h, jar, "POST", "/api/agent/new", { cwd: "/nonexistent-dir-xyz" }, { Origin: "https://evil.example" });
    assert.equal(noFetchMeta.status, 403);
    const same = await call(h, jar, "POST", "/api/agent/new", { cwd: "/nonexistent-dir-xyz" }, { Origin: h.baseUrl });
    assert.equal(same.status, 400, "same origin gets through to the handler (bad cwd)");
    // GET is never blocked on this ground.
    assert.equal((await call(h, jar, "GET", "/api/sessions", undefined, evil)).status, 200);
  });
});

test("PI_WEB_ALLOWED_ORIGINS admits a front-end origin that differs from Host", async () => {
  await withProtectedServer(
    async (h) => {
      const res = await call(h, new Jar(), "POST", "/api/auth/login", { password: PASSWORD }, { Origin: "https://pi.example.com" });
      assert.equal(res.status, 200);
    },
    { allowedOrigins: ["https://pi.example.com/"] },
  );
});

test("the bridge routes take only the bridge token, never a browser session", async () => {
  await withProtectedServer(async (h) => {
    const jar = new Jar();
    await login(h, jar);
    const path = "/api/bridge/some-session/events";
    assert.equal((await call(h, jar, "POST", path, { event: {} })).status, 401, "a logged-in browser cannot drive a bridge");
    const bearerBrowser = await fetch(`${h.baseUrl}${path}`, { method: "POST", headers: { Authorization: "Bearer nope", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(bearerBrowser.status, 401);
    // With the token, auth passes and the route's own answer (no bridge attached) comes back.
    const ok = await fetch(`${h.baseUrl}${path}`, { method: "POST", headers: { Authorization: `Bearer ${h.bridgeToken}`, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(ok.status, 404);
    // And the bridge token opens nothing else.
    const other = await fetch(`${h.baseUrl}/api/sessions`, { headers: { Authorization: `Bearer ${h.bridgeToken}` } });
    assert.equal(other.status, 401);
  });
});

test("changing the password while the server runs signs every browser out", async () => {
  await withProtectedServer(async (h) => {
    const jar = new Jar();
    await login(h, jar);
    assert.equal((await call(h, jar, "GET", "/api/sessions")).status, 200);

    await writeWebPassword("a brand new long password", h.configPath);
    assert.equal((await call(h, jar, "GET", "/api/sessions")).status, 401);
    assert.equal((await call(h, jar, "POST", "/api/auth/refresh", {})).status, 401);
    assert.equal((await login(h, new Jar())).status, 401, "the old password is dead");
    assert.equal((await login(h, new Jar(), "a brand new long password")).status, 200);
  });
});

test("a corrupt auth file fails closed instead of serving unprotected", async () => {
  await withProtectedServer(async (h) => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(h.configPath, "{ broken");
    const res = await fetch(`${h.baseUrl}/api/sessions`);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { code: string }).code, "auth_unavailable");
    assert.equal((await fetch(`${h.baseUrl}/api/health`)).status, 200);
    assert.deepEqual(await (await fetch(`${h.baseUrl}/api/auth/status`)).json(), { required: true, authenticated: false, unavailable: true });
  });
});

test("without a password nothing changes: the API is open and auth routes say so", async () => {
  const handle = await startWebServer({ port: 0, host: "127.0.0.1", auth: new WebAuthService({ configPath: null }) });
  try {
    const base = `http://127.0.0.1:${handle.port}`;
    assert.equal((await fetch(`${base}/api/sessions`)).status, 200);
    assert.deepEqual(await (await fetch(`${base}/api/auth/status`)).json(), { required: false, authenticated: true });
    assert.equal((await fetch(`${base}/api/auth/login`, { method: "POST", body: "{}" })).status, 404);
  } finally {
    await handle.close();
  }
});

function fakeCore(id: string): SessionCore {
  return {
    sessionId: id,
    subscribe: () => () => {},
    prompt: async () => {},
    abort: async () => {},
    isStreaming: () => false,
    getState: () => ({
      sessionId: id,
      sessionFile: "",
      isStreaming: false,
      isBashRunning: false,
      isCompacting: false,
      model: undefined,
      contextUsage: null,
      thinkingLevel: "off",
    }),
  };
}
