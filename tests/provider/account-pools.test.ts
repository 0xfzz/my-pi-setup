import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountLabel, agentStatePath, describeHealth, emptyState, healthFor,
  isAuthError, isQuotaError, mergeConfigs, normalizeState, parseRouterConfig, quotaRetryMs, readRouterConfig,
  readRouterState, recordFailure, recordSuccess, selectAccount, writeRouterState,
  type PoolConfig,
} from "../../lib/provider/account-pools.ts";
import { advanceChain, mergeRouteTables, parseModelRef, parseRouteTable, targetPool } from "../../lib/provider/model-routes.ts";

async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-account-router-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const pool = (overrides: Partial<PoolConfig> = {}): PoolConfig => ({
  provider: "antigravity",
  strategy: "round-robin",
  accounts: [{ id: "a" }, { id: "b" }, { id: "c" }],
  ...overrides,
});

// ── Config parsing ───────────────────────────────────────────────────────────

test("pool config rejects structural errors with actionable messages", () => {
  const { config, errors } = parseRouterConfig({
    pools: {
      noProvider: { strategy: "round-robin" },
      badStrategy: { provider: "x", strategy: "round_robin" },
      dupes: { provider: "x", accounts: [{ id: "a" }, { id: "a" }] },
      noId: { provider: "x", accounts: [{ label: "no id" }] },
      badAccounts: { provider: "x", accounts: {} },
      badCooldown: { provider: "x", cooldownMs: -1 },
      badFailures: { provider: "x", maxConsecutiveFailures: 1.5 },
      good: { provider: "x", accounts: [{ id: "a", apiKey: "$K" }] },
    },
  });
  assert.deepEqual(Object.keys(config.pools), ["good"]);
  const text = errors.join("\n");
  for (const fragment of [
    '"provider" is required', 'unknown strategy "round_robin"', 'duplicate account id "a"',
    'requires a non-empty "id"', '"accounts" must be an array', '"cooldownMs" must be a non-negative number',
    '"maxConsecutiveFailures" must be a non-negative integer',
  ]) assert.ok(text.includes(fragment), `missing: ${fragment}`);
});

test("pool config defaults are applied and unknown keys are ignored", () => {
  const { config, errors } = parseRouterConfig({ pools: { p: { provider: "x", extra: true } } });
  assert.deepEqual(errors, []);
  assert.equal(config.pools.p.strategy, "round-robin");
  assert.deepEqual(config.pools.p.accounts, []);
  assert.equal(config.pools.p.cooldownMs, undefined);
  assert.equal(parseRouterConfig([]).errors.length, 1);
  assert.equal(parseRouterConfig({}).errors.length, 1);
});

test("project pools override global pools of the same name", () => {
  const global = parseRouterConfig({ pools: { a: { provider: "g" }, b: { provider: "g" } } }).config;
  const project = parseRouterConfig({ pools: { b: { provider: "p" } } }).config;
  const merged = mergeConfigs(global, project);
  assert.equal(merged.pools.a.provider, "g");
  assert.equal(merged.pools.b.provider, "p");
});

test("malformed config files are reported, missing files are empty", async () => fixture(async dir => {
  const path = join(dir, "account-router.json");
  assert.deepEqual(readRouterConfig(path), { config: { pools: {} }, errors: [] });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, "{not json");
  const read = readRouterConfig(path);
  assert.deepEqual(read.config.pools, {});
  assert.equal(read.errors.length, 1);
}));

// ── State ────────────────────────────────────────────────────────────────────

test("state round-trips atomically with owner-only permissions", async () => fixture(async dir => {
  const path = agentStatePath(dir);
  assert.deepEqual(readRouterState(path), emptyState());
  const state = emptyState();
  recordFailure(state, "p", "a", "HTTP 429", { now: 1000, cooldownMs: 500 });
  recordSuccess(state, "p", "b", 2000);
  assert.equal(writeRouterState(path, state), true);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const reloaded = readRouterState(path);
  assert.deepEqual(reloaded, state);
  assert.ok(JSON.parse(await readFile(path, "utf8")));
  assert.ok(!(await readFile(path, "utf8")).includes(".tmp"), "temp file is renamed away");
}));

test("corrupt or foreign state never crashes a session", async () => fixture(async dir => {
  const path = agentStatePath(dir);
  const { writeFile } = await import("node:fs/promises");
  for (const body of ["{oops", "null", '{"version":2}', "[]"]) {
    await writeFile(path, body);
    assert.deepEqual(readRouterState(path), emptyState());
  }
  assert.equal(normalizeState({ version: 1, health: { p: { a: { failures: "x" } } } }).health.p.a.failures, 0);
  assert.equal(normalizeState({ version: 1, cursor: { p: 5 } }).cursor.p, undefined);
}));

// ── Selection strategies ─────────────────────────────────────────────────────

test("round-robin rotates and wraps, skipping nothing while all are healthy", () => {
  const state = emptyState();
  const p = pool();
  const picks = [0, 1, 2, 3].map(() => selectAccount(p, state, { now: 0 })!.account.id);
  // The cursor advances only on recorded outcomes, so selection itself is stable.
  assert.deepEqual(picks, ["a", "a", "a", "a"]);
  recordSuccess(state, "antigravity", "a", 0);
  assert.equal(selectAccount(p, state, { now: 0 })!.account.id, "b");
  recordSuccess(state, "antigravity", "b", 0);
  assert.equal(selectAccount(p, state, { now: 0 })!.account.id, "c");
  recordSuccess(state, "antigravity", "c", 0);
  assert.equal(selectAccount(p, state, { now: 0 })!.account.id, "a", "wraps around");
});

test("least-recently-used prefers the account idle longest", () => {
  const state = emptyState();
  const p = pool({ strategy: "least-recently-used" });
  recordSuccess(state, "antigravity", "a", 500);
  recordSuccess(state, "antigravity", "b", 100);
  recordSuccess(state, "antigravity", "c", 300);
  assert.equal(selectAccount(p, state, { now: 1000 })!.account.id, "b");
});

test("priority keeps declaration order among usable accounts", () => {
  const state = emptyState();
  const p = pool({ strategy: "priority" });
  recordSuccess(state, "antigravity", "a", 900);
  assert.equal(selectAccount(p, state, { now: 1000 })!.account.id, "a");
  // Priority is strict: one failure does not demote within the failure budget.
  recordFailure(state, "antigravity", "a", "boom");
  assert.equal(selectAccount(p, state, { now: 1000 })!.account.id, "a");
  assert.equal(selectAccount(p, state, { now: 1000 })!.exhausted, false);
  // A quota wall cools it down, so the next priority account takes over.
  recordFailure(state, "antigravity", "a", "HTTP 429", { now: 1000, cooldownMs: 5000 });
  assert.equal(selectAccount(p, state, { now: 1000 })!.account.id, "b");
});

test("sticky holds the current account until it becomes unusable", () => {
  const state = emptyState();
  const p = pool({ strategy: "sticky" });
  recordSuccess(state, "antigravity", "b", 100);
  assert.equal(selectAccount(p, state, { now: 1000 })!.account.id, "b");
  assert.equal(selectAccount(p, state, { now: 1000 })!.account.id, "b");
  recordFailure(state, "antigravity", "b", "HTTP 429", { now: 1000, cooldownMs: 5000 });
  assert.equal(selectAccount(p, state, { now: 1000 })!.account.id, "a");
});

test("cooling-down accounts are skipped until their cooldown expires", () => {
  const state = emptyState();
  const p = pool({ cooldownMs: 1000 });
  recordFailure(state, "antigravity", "a", "HTTP 429", { now: 0, cooldownMs: 1000 });
  assert.equal(selectAccount(p, state, { now: 500 })!.account.id, "b");
  assert.equal(selectAccount(p, state, { now: 500 })!.exhausted, false);
  recordSuccess(state, "antigravity", "b", 500);
  recordSuccess(state, "antigravity", "c", 500);
  // a is still cooling, b and c are the only options
  const picked = selectAccount(p, state, { now: 600 })!;
  assert.notEqual(picked.account.id, "a");
  // After the cooldown it is eligible again.
  recordSuccess(state, "antigravity", "b", 1500);
  recordSuccess(state, "antigravity", "c", 1500);
  assert.equal(selectAccount(p, state, { now: 1500 })!.account.id, "a");
});

test("an exhausted pool never falls back to a cooling account", () => {
  const state = emptyState();
  const p = pool({ cooldownMs: 10_000 });
  for (const id of ["a", "b", "c"]) recordFailure(state, "antigravity", id, "HTTP 429", { now: 0, cooldownMs: 10_000 });
  const picked = selectAccount(p, state, { now: 100 });
  assert.equal(picked, undefined, "quota cooldowns remain hard exclusions even when all accounts are exhausted");
});

test("maxConsecutiveFailures retires an account after its budget", () => {
  const state = emptyState();
  const p = pool({ maxConsecutiveFailures: 2 });
  recordFailure(state, "antigravity", "a", "boom", { now: 0 });
  assert.equal(selectAccount(p, state, { now: 0 })!.account.id, "a", "one failure keeps it in rotation");
  recordFailure(state, "antigravity", "a", "boom", { now: 0 });
  assert.equal(selectAccount(p, state, { now: 0 })!.account.id, "b");
  recordSuccess(state, "antigravity", "a", 0);
  assert.equal(healthFor(state, "antigravity", "a").failures, 0, "success clears the budget");
});

test("a model-concurrency error never spends an account's failure budget", () => {
  const state = emptyState();
  const p = pool({ maxConsecutiveFailures: 1 });
  // A cluster-wide limit is not the account's fault: record it for status only.
  recordFailure(state, "antigravity", "a", "model_concurrency limit reached", { now: 0 });
  assert.equal(healthFor(state, "antigravity", "a").failures, 0, "concurrency is not a per-account failure");
  assert.equal(healthFor(state, "antigravity", "a").cooldownUntil, undefined, "concurrency must not cool the account");
  assert.equal(healthFor(state, "antigravity", "a").needsProbe, undefined);
  assert.equal(selectAccount(p, state, { now: 0 })!.account.id, "a", "still selectable after a cluster-wide limit");
  // A real per-account failure afterwards still spends the budget.
  recordFailure(state, "antigravity", "a", "boom", { now: 0 });
  assert.equal(healthFor(state, "antigravity", "a").failures, 1);
  assert.equal(selectAccount(p, state, { now: 0 })!.account.id, "b");
});

test("exclude removes accounts already tried in this request", () => {
  const state = emptyState();
  const p = pool();
  assert.equal(selectAccount(p, state, { exclude: ["a"] })!.account.id, "b");
  assert.equal(selectAccount(p, state, { exclude: ["a", "b"] })!.account.id, "c");
  assert.equal(selectAccount(p, state, { exclude: ["a", "b", "c"] }), undefined);
});

test("exhausted reports the last usable candidate without changing the selection", () => {
  const state = emptyState();
  const p = pool();
  // Three usable accounts: no fallback warning.
  assert.equal(selectAccount(p, state, { now: 0 })!.exhausted, false);
  // Excluding two leaves exactly one usable candidate.
  const last = selectAccount(p, state, { exclude: ["a", "b"] })!;
  assert.equal(last.account.id, "c");
  assert.equal(last.exhausted, true, "a single usable candidate means no fallback remains");
  // A cooling account shrinks the usable set but never changes the pick.
  const cooling = emptyState();
  const q = pool({ cooldownMs: 1000 });
  recordFailure(cooling, "antigravity", "b", "HTTP 429", { now: 0, cooldownMs: 1000 });
  recordFailure(cooling, "antigravity", "c", "HTTP 429", { now: 0, cooldownMs: 1000 });
  const sole = selectAccount(q, cooling, { now: 500 })!;
  assert.equal(sole.account.id, "a");
  assert.equal(sole.exhausted, true, "the only account not cooling down is the last fallback");
});

test("a pool with no accounts selects nothing", () => {
  assert.equal(selectAccount(pool({ accounts: [] }), emptyState()), undefined);
});

test("quota reset durations override short cooldowns and require recovery probes", () => {
  const state = emptyState();
  const error = "Quota reached. Please wait 54h10m43s. Next: switch models or try again after reset.";
  const delay = (54 * 3600 + 10 * 60 + 43) * 1000;
  assert.equal(quotaRetryMs(error), delay);
  assert.equal(quotaRetryMs("HTTP 429 retry after 2 hours 3 minutes 4 seconds"), 7_384_000);
  assert.equal(quotaRetryMs("quota reached, retry in 1.5s"), 1500);
  assert.equal(quotaRetryMs("quota reached, retry in 100ms"), 100);
  assert.equal(quotaRetryMs("You've used today's Free usage. It resets in 22h 21m. Add a usage pack to keep going"), (22 * 3600 + 21 * 60) * 1000);
  assert.equal(quotaRetryMs("quota reached, please wait for reset"), undefined);
  assert.equal(quotaRetryMs("network error, retry in 2s"), undefined);
  const p = pool({ accounts: [{ id: "a" }], maxConsecutiveFailures: 1 });
  recordFailure(state, "antigravity", "a", error, { now: 100, cooldownMs: 10 });
  const health = healthFor(state, "antigravity", "a");
  assert.equal(health.cooldownUntil, 100 + delay);
  assert.equal(health.needsProbe, true);
  assert.equal(selectAccount(p, state, { now: 100 + delay - 1 }), undefined);
  assert.equal(selectAccount(p, state, { now: 100 + delay })?.account.id, "a",
    "a quota account can recover even after its failure budget is exhausted");
  assert.equal(describeHealth(health, 100 + delay), "awaiting recovery probe");
  recordFailure(state, "antigravity", "a", "network error", { now: 100 + delay, cooldownMs: 2000 });
  assert.equal(health.needsProbe, true);
  assert.equal(selectAccount(p, state, { now: 101 + delay }), undefined);
  recordSuccess(state, "antigravity", "a", 3000 + delay);
  assert.equal(health.needsProbe, undefined);
  assert.equal(health.cooldownUntil, undefined);
});

test("401 auth errors immediately retire an account from pool selection", () => {
  const state = emptyState();
  const p = pool({ accounts: [{ id: "acc-1" }, { id: "acc-2" }], maxConsecutiveFailures: 3 });
  assert.equal(selectAccount(p, state)?.account.id, "acc-1");

  recordFailure(state, "p", "acc-1", 'Error: 401: {"message":"Request failed.","type":"auth_error"}');
  assert.equal(healthFor(state, "p", "acc-1").authFailed, true);
  assert.equal(describeHealth(healthFor(state, "p", "acc-1")), "auth failed");

  // acc-1 is immediately skipped even though failures (1) < maxConsecutiveFailures (3)
  assert.equal(selectAccount(p, state, { poolName: "p" })?.account.id, "acc-2");
});

test("402 budget exceeded errors trigger quota cooldown and probe", () => {
  const state = emptyState();
  const p = pool({ accounts: [{ id: "acc-1" }], cooldownMs: 1000 });
  const error402 = 'Error: 402: {"message":"You\'ve used today\'s Free usage. It resets in 2h.","type":"budget_exceeded"}';
  assert.equal(isQuotaError(error402), true);

  recordFailure(state, "p", "acc-1", error402, { now: 1000, cooldownMs: 5000 });
  const health = healthFor(state, "p", "acc-1");
  assert.equal(health.needsProbe, true);
  assert.equal(health.cooldownUntil, 1000 + 2 * 3600 * 1000);
  assert.equal(selectAccount(p, state, { poolName: "p", now: 1000 + 2 * 3600 * 1000 - 1 }), undefined, "account is in cooldown");
});

test("legacy persisted quota failures require a probe when their cooldown ends", () => {
  const state = normalizeState({ version: 1, health: { p: { a: {
    failures: 5, cooldownUntil: 100, lastError: "Quota reached. Please wait 2h.",
  } } } });
  assert.equal(healthFor(state, "p", "a").needsProbe, true);
  assert.equal(selectAccount(pool({ accounts: [{ id: "a" }] }), state, { poolName: "p", now: 200 })?.account.id, "a");
  assert.deepEqual(normalizeState(state), state);
  const migrated = normalizeState({ version: 1, health: { p: { a: {
    failures: 1, cooldownUntil: 61_000, lastUsedAt: 1000, lastError: "Quota reached. Please wait 54h10m43s.",
  } } } });
  assert.equal(healthFor(migrated, "p", "a").cooldownUntil, 1000 + (54 * 3600 + 10 * 60 + 43) * 1000);
  assert.deepEqual(normalizeState(migrated), migrated, "migration does not shift the deadline again");
});

// ── Error classification and labels ──────────────────────────────────────────

test("quota and auth failures are classified for the right recovery", () => {
  for (const message of ["HTTP 429", "rate limit exceeded", "quota exceeded", "RESOURCE_EXHAUSTED",
    "Too Many Requests", "insufficient_quota", "429 Too Many Requests"]) {
    assert.equal(isQuotaError(message), true, message);
  }
  for (const message of ["HTTP 500", "network error", undefined, "context length exceeded", "This model is unavailable. This is not necessarily an account quota wall."]) {
    assert.equal(isQuotaError(message), false, String(message));
  }
  for (const message of ["HTTP 401", "invalid_grant", "unauthorized", "token expired", "invalid_token"]) {
    assert.equal(isAuthError(message), true, message);
  }
  assert.equal(isAuthError("HTTP 429"), false);
});

test("account labels and health descriptions are readable", () => {
  assert.equal(accountLabel({ id: "a" }), "a");
  assert.equal(accountLabel({ id: "a", label: "a@b.c" }), "a@b.c (a)");
  assert.equal(describeHealth({ failures: 0 }, 0), "unused");
  assert.equal(describeHealth({ failures: 0, lastOkAt: 5 }, 0), "ok");
  assert.equal(describeHealth({ failures: 2 }, 0), "2 consecutive failure(s)");
  assert.equal(describeHealth({ failures: 0, cooldownUntil: 5000 }, 0), "cooling down 5s");
});

// ── Routes ───────────────────────────────────────────────────────────────────

test("model refs require provider/model and keep slashes in the model id", () => {
  assert.deepEqual(parseModelRef("antigravity/gemini-3-pro"), { provider: "antigravity", modelId: "gemini-3-pro" });
  assert.deepEqual(parseModelRef("openrouter/meta/llama-3"), { provider: "openrouter", modelId: "meta/llama-3" });
  for (const bad of ["nogslash", "/model", "provider/", ""]) assert.equal(parseModelRef(bad), undefined, bad);
});

test("route tables normalize targets, pools and thinking", () => {
  const { table, errors } = parseRouteTable({
    provider: "router",
    routes: [
      { name: "auto", targets: ["a/x", { model: "b/y", pool: "pb", thinking: "high" }], pool: "default" },
      { name: "auto", targets: ["c/z"] },
      { name: "bad space", targets: ["a/x"] },
      { name: "broken", targets: ["noslash"] },
      { name: "empty", targets: [] },
    ],
  });
  const text = errors.join("\n");
  for (const fragment of [
    'route "auto": duplicate name',
    'may only contain letters, digits',
    'expected "provider/model"',
    'at least one target is required',
  ]) assert.ok(text.includes(fragment), `missing: ${fragment}`);
  assert.equal(errors.length, 4);
  assert.equal(table.routes.length, 1);
  assert.deepEqual(table.routes[0].targets, [
    { model: "a/x" },
    { model: "b/y", pool: "pb", thinking: "high" },
  ]);
  assert.equal(targetPool(table.routes[0], table.routes[0].targets[0]), "default");
  assert.equal(targetPool(table.routes[0], table.routes[0].targets[1]), "pb");
});

test("project routes override global routes by name and keep order", () => {
  const global = parseRouteTable({ routes: [{ name: "a", targets: ["g/x"] }, { name: "b", targets: ["g/y"] }] }).table;
  const project = parseRouteTable({ routes: [{ name: "b", targets: ["p/y"] }] }).table;
  const merged = mergeRouteTables(global, project);
  assert.deepEqual(merged.routes.map((route) => route.name), ["a", "b"]);
  assert.equal(merged.routes[1].targets[0].model, "p/y");
});

test("advanceChain skips the failed model but keeps every other candidate", () => {
  const route = { name: "r", targets: [{ model: "a/1" }, { model: "a/2" }, { model: "a/3" }] };
  assert.deepEqual(advanceChain(route, "a/2").map((target) => target.model), ["a/3", "a/1"]);
  assert.deepEqual(advanceChain(route, "z/9").map((target) => target.model), ["a/2", "a/3"]);
});
