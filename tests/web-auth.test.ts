import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WebAuthConfigCache,
  loadWebAuthConfig,
  removeWebPassword,
  writeWebPassword,
} from "../lib/web-auth/config.ts";
import { deriveKey, signJwt, verifyJwt, type JwtClaims } from "../lib/web-auth/jwt.ts";
import { hashPassword, passwordProblem, verifyPassword } from "../lib/web-auth/password.ts";
import { WebAuthService, type IssuedTokens } from "../lib/web-auth/service.ts";
import { LoginThrottle } from "../lib/web-auth/throttle.ts";

const PASSWORD = "correct horse battery";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-web-auth-"));
}

function clock(start = 1_800_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

async function enabledService(
  dir: string,
  time: ReturnType<typeof clock>,
  extra: Partial<ConstructorParameters<typeof WebAuthService>[0]> = {},
): Promise<WebAuthService> {
  const configPath = join(dir, "web-auth.json");
  await writeWebPassword(PASSWORD, configPath);
  return new WebAuthService({ configPath, now: time.now, ...extra });
}

async function login(service: WebAuthService): Promise<IssuedTokens> {
  const result = await service.login(PASSWORD, "client-a");
  assert.ok(result.ok, "login should succeed");
  return result.tokens;
}

test("jwt: signs and verifies, and rejects tampering, wrong use, wrong key and expiry", () => {
  const secret = Buffer.alloc(32, 7);
  const access = deriveKey(secret, "access");
  const refresh = deriveKey(secret, "refresh");
  assert.notDeepEqual(access, refresh, "access and refresh keys must differ");

  const now = 1_800_000_000_000;
  const claims: JwtClaims = {
    iss: "pi-web", aud: "pi-web", sub: "owner", use: "access",
    iat: now / 1000, exp: now / 1000 + 60, jti: "j", sid: "s",
  };
  const token = signJwt(claims, access, "k1");
  const base = { key: access, kid: "k1", use: "access" as const, now, leewaySeconds: 5 };
  assert.deepEqual(verifyJwt(token, base), { ok: true, claims });

  // Tampered payload.
  const [h, p, s] = token.split(".") as [string, string, string];
  const forgedPayload = Buffer.from(JSON.stringify({ ...claims, sid: "other" })).toString("base64url");
  assert.equal(verifyJwt(`${h}.${forgedPayload}.${s}`, base).ok, false);
  // alg=none and an empty signature.
  const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: "k1" })).toString("base64url");
  assert.equal(verifyJwt(`${none}.${p}.`, base).ok, false);
  // A refresh-keyed token cannot be used as an access token, nor an access one as refresh.
  assert.deepEqual(verifyJwt(signJwt({ ...claims, use: "refresh" }, refresh, "k1"), base), { ok: false, reason: "bad_signature" });
  assert.deepEqual(verifyJwt(signJwt({ ...claims, use: "refresh" }, access, "k1"), base), { ok: false, reason: "wrong_claims" });
  // Signed correctly but under a rotated secret.
  assert.deepEqual(verifyJwt(token, { ...base, kid: "k2" }), { ok: false, reason: "wrong_key" });
  // HS256 with the right key but the wrong issuer.
  assert.deepEqual(verifyJwt(signJwt({ ...claims, iss: "evil" }, access, "k1"), base), { ok: false, reason: "wrong_claims" });
  // Expiry, with leeway for clock skew.
  assert.equal(verifyJwt(token, { ...base, now: now + 62_000 }).ok, true, "inside the 5s leeway");
  assert.deepEqual(verifyJwt(token, { ...base, now: now + 66_000 }), { ok: false, reason: "expired" });
  // Issued in the future beyond the leeway.
  assert.deepEqual(verifyJwt(token, { ...base, now: now - 30_000 }), { ok: false, reason: "not_yet_valid" });
  // Garbage never throws.
  for (const junk of ["", "a.b", "a.b.c.d", "x".repeat(5000), "....", "e30.e30.e30"]) {
    assert.equal(verifyJwt(junk, base).ok, false);
  }
  // A hand-rolled signature with the right key but a non-JWT header is refused.
  const badHeader = Buffer.from(JSON.stringify({ alg: "HS512", typ: "JWT", kid: "k1" })).toString("base64url");
  const sig = createHmac("sha256", access).update(`${badHeader}.${p}`).digest("base64url");
  assert.equal(verifyJwt(`${badHeader}.${p}.${sig}`, base).ok, false);
});

test("password: hashes with a salt, verifies, and rejects malformed records", async () => {
  const a = await hashPassword(PASSWORD);
  const b = await hashPassword(PASSWORD);
  assert.notEqual(a, b, "salted");
  assert.ok(a.startsWith("scrypt$32768$8$1$"));
  assert.equal(await verifyPassword(PASSWORD, a), true);
  assert.equal(await verifyPassword("wrong password!", a), false);
  assert.equal(await verifyPassword(PASSWORD, "scrypt$3$8$1$AAAA$AAAA"), false, "non power-of-two cost");
  assert.equal(await verifyPassword(PASSWORD, "scrypt$1073741824$8$1$AAAA$AAAA"), false, "cost beyond the limit");
  assert.equal(await verifyPassword(PASSWORD, "not a record"), false);
  assert.equal(await verifyPassword("x".repeat(100_000), a), false);
  assert.equal(passwordProblem("short"), "use at least 10 characters");
  assert.equal(passwordProblem(PASSWORD), null);
});

test("config: private file, fail closed on corruption, picked up without a restart", async () => {
  const dir = tempDir();
  try {
    const path = join(dir, "web-auth.json");
    assert.deepEqual(loadWebAuthConfig(path), { state: "disabled" });

    const cache = new WebAuthConfigCache(path);
    assert.equal(cache.get().state, "disabled");

    const config = await writeWebPassword(PASSWORD, path);
    assert.equal(statSync(path).mode & 0o777, 0o600, "owner-only");
    assert.equal(cache.get().state, "enabled", "the cache sees the new file");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).passwordHash.includes(PASSWORD), false, "never the password");

    const again = await writeWebPassword("another long password", path);
    assert.notEqual(again.secret, config.secret, "a new password rotates the signing secret");
    assert.notEqual(again.bridgeToken, config.bridgeToken);

    writeFileSync(path, "{ not json");
    assert.equal(cache.get().state, "invalid", "corrupt config must not read as 'no password'");
    writeFileSync(path, JSON.stringify({ version: 1, passwordHash: "x" }));
    assert.equal(cache.get().state, "invalid");

    assert.equal(removeWebPassword(path), true);
    assert.equal(cache.get().state, "disabled");
    assert.equal(removeWebPassword(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("throttle: locks one client after repeated failures, refunds a success, caps the total", () => {
  const time = clock(0);
  const throttle = new LoginThrottle({ maxFailures: 3, windowMs: 1000, lockMs: 5000, globalMaxFailures: 5 }, time.now);
  for (let i = 0; i < 3; i++) {
    assert.equal(throttle.check("a").allowed, true);
    throttle.failure("a");
  }
  const locked = throttle.check("a");
  assert.equal(locked.allowed, false);
  assert.equal(locked.allowed === false && locked.retryAfterSeconds, 5);
  assert.equal(throttle.check("b").allowed, true, "other clients are unaffected");
  time.advance(5001);
  assert.equal(throttle.check("a").allowed, true, "lock expires");

  throttle.failure("c");
  throttle.success("c");
  throttle.failure("c");
  throttle.failure("c");
  assert.equal(throttle.check("c").allowed, true, "the refunded attempt does not count");

  const small = new LoginThrottle({ maxFailures: 99, windowMs: 1000, lockMs: 1000, globalMaxFailures: 3 }, time.now);
  for (const who of ["x", "y", "z"]) small.failure(who);
  assert.equal(small.check("w").allowed, false, "global backstop across clients");
  time.advance(1001);
  assert.equal(small.check("w").allowed, true);
});

test("service: login issues a JWT pair, wrong passwords are throttled", async () => {
  const dir = tempDir();
  try {
    const time = clock();
    const service = await enabledService(dir, time, { throttle: { maxFailures: 3 } });
    assert.equal(service.mode(), "enabled");

    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await service.login("wrong password!!", "bad"), { ok: false, reason: "invalid_credentials" });
    }
    const limited = await service.login(PASSWORD, "bad");
    assert.equal(limited.ok, false);
    assert.equal(!limited.ok && limited.reason, "rate_limited", "even the right password waits out a lockout");

    const tokens = await login(service);
    assert.equal(tokens.accessExpiresAt, time.now() + 15 * 60_000);
    assert.equal(tokens.refreshExpiresAt, time.now() + 30 * 86_400_000);
    const access = service.verifyAccess(tokens.accessToken);
    assert.ok(access.ok);
    assert.equal(access.ok && access.sessionId, tokens.sessionId);
    assert.equal(service.verifyAccess(tokens.refreshToken).ok, false, "a refresh token is not an access token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service: access tokens expire and a refresh rotates both tokens", async () => {
  const dir = tempDir();
  try {
    const time = clock();
    const service = await enabledService(dir, time);
    const first = await login(service);

    time.advance(16 * 60_000);
    const expired = service.verifyAccess(first.accessToken);
    assert.deepEqual(expired, { ok: false, reason: "expired" });

    const refreshed = service.refresh(first.refreshToken);
    assert.ok(refreshed.ok && refreshed.rotated);
    const second = refreshed.ok && refreshed.rotated ? refreshed.tokens : null;
    assert.ok(second);
    assert.notEqual(second.refreshToken, first.refreshToken);
    assert.equal(service.verifyAccess(second.accessToken).ok, true);
    assert.equal(second.refreshExpiresAt, time.now() + 30 * 86_400_000, "the sliding window restarts on use");

    // The new refresh token keeps working, indefinitely, as long as it is used.
    time.advance(20 * 86_400_000);
    const third = service.refresh(second.refreshToken);
    assert.ok(third.ok && third.rotated);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service: two concurrent refreshes with the same token both succeed (no spurious logout)", async () => {
  const dir = tempDir();
  try {
    const time = clock();
    const service = await enabledService(dir, time);
    const first = await login(service);
    time.advance(14 * 60_000);

    const a = service.refresh(first.refreshToken);
    time.advance(300);
    const b = service.refresh(first.refreshToken);
    assert.ok(a.ok && a.rotated);
    assert.ok(b.ok && !b.rotated, "the duplicate gets an access token only");
    assert.equal(service.verifyAccess(b.ok && !b.rotated ? b.accessToken : "").ok, true);

    // The session survives: the token from the first refresh still works.
    const next = service.refresh(a.ok && a.rotated ? a.tokens.refreshToken : "");
    assert.ok(next.ok && next.rotated);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service: replaying a retired refresh token after the grace window revokes the whole session", async () => {
  const dir = tempDir();
  try {
    const time = clock();
    const service = await enabledService(dir, time);
    const first = await login(service);
    const rotated = service.refresh(first.refreshToken);
    assert.ok(rotated.ok && rotated.rotated);
    const current = rotated.ok && rotated.rotated ? rotated.tokens : null;
    assert.ok(current);

    time.advance(11_000);
    assert.deepEqual(service.refresh(first.refreshToken), { ok: false, reason: "reuse_detected" });
    // The thief burned the family: the legitimate holder is signed out too, and so is the access token.
    assert.deepEqual(service.refresh(current.refreshToken), { ok: false, reason: "invalid" });
    assert.deepEqual(service.verifyAccess(current.accessToken), { ok: false, reason: "revoked" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service: refresh tokens expire when idle and are capped by the absolute lifetime", async () => {
  const dir = tempDir();
  try {
    const time = clock();
    const service = await enabledService(dir, time, { absoluteTtlSeconds: 40 * 86_400, refreshTtlSeconds: 30 * 86_400 });
    const first = await login(service);

    time.advance(31 * 86_400_000);
    assert.deepEqual(service.refresh(first.refreshToken), { ok: false, reason: "expired" }, "idle for longer than 30 days");

    const second = await login(service);
    time.advance(25 * 86_400_000);
    const rotated = service.refresh(second.refreshToken);
    assert.ok(rotated.ok && rotated.rotated);
    const tokens = rotated.ok && rotated.rotated ? rotated.tokens : null;
    assert.ok(tokens);
    assert.equal(tokens.refreshExpiresAt, second.refreshExpiresAt - 30 * 86_400_000 + 40 * 86_400_000, "capped at the absolute lifetime");
    time.advance(16 * 86_400_000);
    assert.equal(service.refresh(tokens.refreshToken).ok, false, "past the absolute lifetime");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service: logout revokes the session at once and notifies listeners", async () => {
  const dir = tempDir();
  try {
    const time = clock();
    const service = await enabledService(dir, time);
    const revoked: string[] = [];
    service.onRevoke((id) => revoked.push(id));
    const tokens = await login(service);
    assert.equal(service.sessionOfRefreshToken(tokens.refreshToken), tokens.sessionId);

    service.logout(tokens.sessionId);
    assert.deepEqual(revoked, [tokens.sessionId]);
    assert.deepEqual(service.verifyAccess(tokens.accessToken), { ok: false, reason: "revoked" });
    assert.deepEqual(service.refresh(tokens.refreshToken), { ok: false, reason: "invalid" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service: sessions survive a restart; a password change signs everyone out", async () => {
  const dir = tempDir();
  try {
    const time = clock();
    const configPath = join(dir, "web-auth.json");
    await writeWebPassword(PASSWORD, configPath);
    const before = new WebAuthService({ configPath, now: time.now });
    const tokens = await login(before);

    // A new server process (`/web reload`) honors the same tokens.
    const after = new WebAuthService({ configPath, now: time.now });
    assert.equal(after.verifyAccess(tokens.accessToken).ok, true);
    const refreshed = after.refresh(tokens.refreshToken);
    assert.ok(refreshed.ok && refreshed.rotated);

    // /web set-password while the server keeps running.
    const events: string[] = [];
    after.onRevoke((id) => events.push(id));
    await writeWebPassword("a different long password", configPath);
    assert.deepEqual(after.verifyAccess(tokens.accessToken), { ok: false, reason: "invalid" });
    assert.deepEqual(after.refresh(refreshed.ok && refreshed.rotated ? refreshed.tokens.refreshToken : ""), { ok: false, reason: "invalid" });
    assert.deepEqual(events, ["all"]);
    assert.equal((await after.login(PASSWORD, "c")).ok, false, "the old password is dead");
    assert.equal((await after.login("a different long password", "c")).ok, true);

    // Turning protection off drops everything and the service reports disabled.
    removeWebPassword(configPath);
    assert.equal(after.mode(), "disabled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service: a corrupt config is 'invalid', never 'disabled'", async () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, "web-auth.json");
    writeFileSync(configPath, "garbage");
    const service = new WebAuthService({ configPath });
    assert.equal(service.mode(), "invalid");
    assert.match(service.invalidReason() ?? "", /not valid JSON/);
    assert.deepEqual(await service.login(PASSWORD, "x"), { ok: false, reason: "unavailable" });
    assert.equal(service.verifyBridgeToken("anything"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service: the bridge token is checked in constant time and rotates with the password", async () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, "web-auth.json");
    const config = await writeWebPassword(PASSWORD, configPath);
    const service = new WebAuthService({ configPath });
    assert.equal(service.verifyBridgeToken(config.bridgeToken), true);
    assert.equal(service.verifyBridgeToken(`${config.bridgeToken}x`), false);
    assert.equal(service.verifyBridgeToken(""), false);
    const next = await writeWebPassword(PASSWORD, configPath);
    assert.equal(service.verifyBridgeToken(config.bridgeToken), false);
    assert.equal(service.verifyBridgeToken(next.bridgeToken), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service: no config means protection is off", () => {
  const service = new WebAuthService({ configPath: null });
  assert.equal(service.mode(), "disabled");
});
