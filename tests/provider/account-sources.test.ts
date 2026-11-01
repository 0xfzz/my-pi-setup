import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANTIGRAVITY_SOURCE, accountIsFresh, antigravityAccountsPath, maskAccountLabel, poolAccounts,
  readAntigravityAccounts, resolveAccountCredential, resolveStaticKey, STATIC_SOURCE,
  type SourceContext, type StoredAntigravityAccount,
} from "../../lib/provider/account-sources.ts";
import type { PoolConfig } from "../../lib/provider/account-pools.ts";

async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-account-sources-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const NOW = 1_000_000;
const FUTURE = NOW + 3_600_000;

function antigravityStore(accounts: StoredAntigravityAccount[], active?: string): string {
  return JSON.stringify({ version: 1, activeAccountId: active, accounts: Object.fromEntries(accounts.map((a) => [a.accountId, a])) });
}

function source(dir: string, overrides: Partial<SourceContext> = {}): SourceContext {
  return { agentDir: dir, now: NOW, ...overrides };
}

const pool = (overrides: Partial<PoolConfig> = {}): PoolConfig =>
  ({ provider: "antigravity", strategy: "round-robin", accounts: [], ...overrides });

// ── Static keys ──────────────────────────────────────────────────────────────

test("static keys resolve literals, environment references and escapes", () => {
  const env = { HOME_KEY: "secret-value", EMPTY: "" };
  assert.deepEqual(resolveStaticKey("literal-key", env), { value: "literal-key" });
  assert.deepEqual(resolveStaticKey("$HOME_KEY", env), { value: "secret-value" });
  assert.deepEqual(resolveStaticKey("${HOME_KEY}", env), { value: "secret-value" });
  // `$$` and `$!` are escapes, not references.
  assert.deepEqual(resolveStaticKey("$$HOME_KEY", env), { value: "$HOME_KEY" });
  assert.deepEqual(resolveStaticKey("$!proxy", env), { value: "!proxy" });
  // A missing or empty variable is an error, never an empty credential.
  assert.ok("error" in resolveStaticKey("$MISSING", env));
  assert.ok("error" in resolveStaticKey("$EMPTY", env));
});

test("command keys run only for an explicit !command and never leak values", () => {
  const ok = resolveStaticKey("!printf from-command");
  assert.deepEqual(ok, { value: "from-command" });
  const failed = resolveStaticKey("!exit 3");
  assert.ok("error" in failed);
  const empty = resolveStaticKey("!true");
  assert.ok("error" in empty);
  assert.ok("error" in resolveStaticKey("!"));
});

// ── Antigravity login store ──────────────────────────────────────────────────

test("the antigravity store is read without exposing tokens to list callers", async () => fixture(async dir => {
  await writeFile(antigravityAccountsPath(dir), antigravityStore([
    { accountId: "one@gmail.com", email: "one@gmail.com", access: "tok-1", refresh: "ref-1", expires: FUTURE, projectId: "p1" },
    { accountId: "two@gmail.com", email: "two@gmail.com", access: "tok-2", refresh: "ref-2", expires: FUTURE, projectId: "p1" },
    { accountId: "broken@gmail.com", email: "broken@gmail.com" },
  ], "two@gmail.com"));

  const accounts = readAntigravityAccounts(source(dir));
  assert.deepEqual(accounts.map((a) => a.accountId), ["one@gmail.com", "two@gmail.com"], "accounts without a refresh token are skipped");
  const listed = poolAccounts(pool({ source: ANTIGRAVITY_SOURCE }), source(dir));
  assert.deepEqual(listed.map((a) => a.label), ["one@gmail.com", "two@gmail.com"]);
  assert.ok(!JSON.stringify(listed).includes("tok-"), "listing never exposes an access token");
}));

test("missing, malformed and empty stores degrade to no accounts", async () => fixture(async dir => {
  assert.deepEqual(readAntigravityAccounts(source(dir)), []);
  for (const body of ["{oops", "null", "[]", '{"version":1}', '{"accounts":[]}']) {
    await writeFile(antigravityAccountsPath(dir), body);
    assert.deepEqual(readAntigravityAccounts(source(dir)), [], body);
  }
}));

test("an explicitly listed pool overrides discovery order", async () => fixture(async dir => {
  await writeFile(antigravityAccountsPath(dir), antigravityStore([
    { accountId: "one@gmail.com", access: "t", refresh: "r", expires: FUTURE },
    { accountId: "two@gmail.com", access: "t", refresh: "r", expires: FUTURE },
  ]));
  const explicit = pool({ source: ANTIGRAVITY_SOURCE, accounts: [{ id: "two@gmail.com" }] });
  assert.deepEqual(poolAccounts(explicit, source(dir)).map((a) => a.id), ["two@gmail.com"]);

  // When accounts is omitted in config, poolAccounts discovers all available
  // accounts (the normalized form always carries the array; this literal mirrors
  // a config file before normalization, and `accounts: []` exercises the same
  // discovery path since poolAccounts checks `accounts?.length`).
  const omitted: PoolConfig = { provider: "antigravity", source: ANTIGRAVITY_SOURCE, strategy: "round-robin", accounts: [] };
  assert.deepEqual(poolAccounts(omitted, source(dir)).map((a) => a.id), ["one@gmail.com", "two@gmail.com"]);
}));

// ── Credential resolution ────────────────────────────────────────────────────

test("a fresh antigravity account resolves to the token+project envelope", async () => fixture(async dir => {
  await writeFile(antigravityAccountsPath(dir), antigravityStore([
    { accountId: "one@gmail.com", access: "tok-1", refresh: "ref-1", expires: FUTURE, projectId: "proj-1" },
  ]));
  const credential = await resolveAccountCredential(
    pool({ source: ANTIGRAVITY_SOURCE }), { id: "one@gmail.com" }, source(dir));
  assert.ok("apiKey" in credential);
  assert.deepEqual(JSON.parse(credential.apiKey!), { token: "tok-1", projectId: "proj-1" });
}));

test("an expired token is refreshed, and a failed refresh reports re-login", async () => fixture(async dir => {
  await writeFile(antigravityAccountsPath(dir), antigravityStore([
    { accountId: "one@gmail.com", access: "stale", refresh: "ref-1", expires: NOW - 1, projectId: "proj-1" },
  ]));
  let refreshes = 0;
  const refreshed = await resolveAccountCredential(
    pool({ source: ANTIGRAVITY_SOURCE }), { id: "one@gmail.com" },
    source(dir, { refresh: async () => { refreshes++; return { accountId: "one@gmail.com", access: "fresh", refresh: "ref-1", expires: FUTURE, projectId: "proj-1" }; } }));
  assert.equal(refreshes, 1);
  assert.deepEqual(JSON.parse((refreshed as { apiKey: string }).apiKey), { token: "fresh", projectId: "proj-1" });

  const noRefresh = await resolveAccountCredential(
    pool({ source: ANTIGRAVITY_SOURCE }), { id: "one@gmail.com" }, source(dir));
  assert.ok("error" in noRefresh && /re-login/.test(noRefresh.error));

  const broken = await resolveAccountCredential(
    pool({ source: ANTIGRAVITY_SOURCE }), { id: "one@gmail.com" },
    source(dir, { refresh: async () => { throw new Error("invalid_grant"); } }));
  assert.ok("error" in broken && /refresh failed/.test(broken.error));
  assert.ok(!JSON.stringify(broken).includes("stale"), "an error never echoes the old token");
}));

test("a refresh that returns no usable token is rejected", async () => fixture(async dir => {
  await writeFile(antigravityAccountsPath(dir), antigravityStore([
    { accountId: "one@gmail.com", access: "stale", refresh: "ref-1", expires: NOW - 1 },
  ]));
  const result = await resolveAccountCredential(
    pool({ source: ANTIGRAVITY_SOURCE }), { id: "one@gmail.com" },
    source(dir, { refresh: async () => ({ accountId: "one@gmail.com", access: "still-stale", refresh: "ref-1", expires: NOW - 1 }) }));
  assert.ok("error" in result && /no usable token/.test(result.error));
}));

test("an unlinked account is reported, not silently swapped", async () => fixture(async dir => {
  await writeFile(antigravityAccountsPath(dir), antigravityStore([
    { accountId: "one@gmail.com", access: "t", refresh: "r", expires: FUTURE },
  ]));
  const result = await resolveAccountCredential(
    pool({ source: ANTIGRAVITY_SOURCE }), { id: "ghost@gmail.com" }, source(dir));
  assert.ok("error" in result && /not linked/.test(result.error));
}));

test("static pools resolve their own account key", async () => {
  const env = { OPENROUTER_KEY_1: "key-one", OPENROUTER_KEY_2: "key-two" };
  const p = pool({ provider: "openrouter", source: STATIC_SOURCE });
  const ctx: SourceContext = { agentDir: join(tmpdir(), "unused"), env };

  const first = await resolveAccountCredential(p, { id: "one", apiKey: "$OPENROUTER_KEY_1" }, ctx);
  assert.deepEqual(first, { apiKey: "key-one" });
  const second = await resolveAccountCredential(p, { id: "two", apiKey: "${OPENROUTER_KEY_2}" }, ctx);
  assert.deepEqual(second, { apiKey: "key-two" });

  // Default source is static, so a pool need not declare it.
  const implicit = await resolveAccountCredential(pool({ provider: "openrouter" }), { id: "x", apiKey: "literal" }, ctx);
  assert.deepEqual(implicit, { apiKey: "literal" });

  const missing = await resolveAccountCredential(p, { id: "none" }, ctx);
  assert.ok("error" in missing && /no apiKey/.test(missing.error));

  const unset = await resolveAccountCredential(p, { id: "bad", apiKey: "$DEFINITELY_NOT_SET_XYZ" }, ctx);
  assert.ok("error" in unset && /not set/.test(unset.error));
});

test("an unknown source is rejected with the pool name", async () => {
  const result = await resolveAccountCredential(
    pool({ provider: "p", source: "mystery" }), { id: "a", apiKey: "k" }, { agentDir: tmpdir() });
  assert.ok("error" in result && /unknown source "mystery"/.test(result.error));
});

// ── Freshness and masking ────────────────────────────────────────────────────

test("freshness reserves a refresh window before expiry", () => {
  assert.equal(accountIsFresh({ accountId: "a", access: "t", expires: FUTURE }, NOW), true);
  // Inside the 5 minute skew the token is treated as expiring.
  assert.equal(accountIsFresh({ accountId: "a", access: "t", expires: NOW + 60_000 }, NOW), false);
  assert.equal(accountIsFresh({ accountId: "a", expires: FUTURE }, NOW), false, "no access token is not fresh");
  assert.equal(accountIsFresh({ accountId: "a", access: "", expires: FUTURE }, NOW), false);
  assert.equal(accountIsFresh({ accountId: "a", access: "t", expires: NOW + 60_000 }, NOW, 0), true);
});

test("account labels are masked for display", () => {
  assert.equal(maskAccountLabel("example.user@gmail.com"), "ex***@gmail.com");
  assert.equal(maskAccountLabel("abc"), "***");
  assert.equal(maskAccountLabel(""), "***");
});

test("models.json accounts are automatically discovered by poolAccounts when accounts list is empty", async () => fixture(async dir => {
  await writeFile(join(dir, "models.json"), JSON.stringify({
    providers: {
      "openrouter-2": { name: "OpenRouter (Account 2)", apiKey: "$KEY_2" },
      "openrouter-1": { name: "OpenRouter (Account 1)", apiKey: "$KEY_1" },
      unrelated: { name: "Unrelated", apiKey: "other" },
    },
  }));

  const env = { KEY_1: "secret-1", KEY_2: "secret-2" };
  const p = pool({ provider: "openrouter", accounts: [] });
  const accounts = poolAccounts(p, source(dir, { env }));

  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].id, "openrouter-1");
  assert.equal(accounts[0].label, "OpenRouter (Account 1)");
  assert.equal(accounts[0].apiKey, "$KEY_1");

  assert.equal(accounts[1].id, "openrouter-2");
  assert.equal(accounts[1].label, "OpenRouter (Account 2)");
  assert.equal(accounts[1].apiKey, "$KEY_2");

  const cred1 = await resolveAccountCredential(p, accounts[0], source(dir, { env }));
  assert.deepEqual(cred1, { apiKey: "secret-1" });

  const cred2 = await resolveAccountCredential(p, accounts[1], source(dir, { env }));
  assert.deepEqual(cred2, { apiKey: "secret-2" });
}));

