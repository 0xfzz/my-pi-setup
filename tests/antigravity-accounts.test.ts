import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  credentialEnvelope, indexForProvider, isCredentialEnvelope, providerForIndex, readAccountSlots,
  slotIsFresh, slotLabel,
} from "../extensions/antigravity-accounts.ts";

const NOW = 1_000_000;
const FUTURE = NOW + 3_600_000;

async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-agy-accounts-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Write an account store shaped like the vendored one. */
async function writeStore(dir: string, accounts: Record<string, unknown>, active?: string) {
  await writeFile(join(dir, "antigravity-accounts.json"), JSON.stringify({
    version: 1, ...(active ? { activeAccountId: active } : {}), accounts,
  }));
}

const account = (overrides: Record<string, unknown> = {}) => ({
  access: "tok", refresh: "ref", expires: FUTURE, projectId: "proj", ...overrides,
});

// ── Provider id mapping ──────────────────────────────────────────────────────

test("account slots map to antigravity-1..n provider ids", () => {
  assert.equal(providerForIndex(1), "antigravity-1");
  assert.equal(providerForIndex(2), "antigravity-2");
  assert.equal(providerForIndex(17), "antigravity-17");
  assert.equal(indexForProvider("antigravity-1"), 1);
  assert.equal(indexForProvider("antigravity-17"), 17);
  for (const bad of ["antigravity", "antigravity-", "antigravity-0", "antigravity-01",
    "antigravity-x", "antigravity-1x", "other-1", ""]) {
    assert.equal(indexForProvider(bad), undefined, bad);
  }
});

test("labels prefer the email and fall back to the account id", () => {
  assert.equal(slotLabel({ email: "a@b.c", accountId: "id" }), "a@b.c");
  assert.equal(slotLabel({ email: "   ", accountId: "id" }), "id");
  assert.equal(slotLabel({ accountId: "id" }), "id");
});

// ── Store reading ────────────────────────────────────────────────────────────

test("accounts are read in stable link order, skipping unusable entries", async () => fixture(async dir => {
  await writeStore(dir, {
    // Deliberately keyed out of order to prove sorting is by link time.
    "third@x.com": account({ accountId: "third@x.com", email: "third@x.com", addedAt: 300 }),
    "first@x.com": account({ accountId: "first@x.com", email: "first@x.com", addedAt: 100 }),
    "second@x.com": account({ accountId: "second@x.com", email: "second@x.com", addedAt: 200 }),
    // No refresh token: cannot be used, must not occupy a slot.
    "broken@x.com": { accountId: "broken@x.com", email: "broken@x.com", access: "tok", addedAt: 50 },
  });
  const slots = readAccountSlots(dir);
  assert.deepEqual(slots.map((s) => s.provider), ["antigravity-1", "antigravity-2", "antigravity-3"]);
  assert.deepEqual(slots.map((s) => s.email), ["first@x.com", "second@x.com", "third@x.com"]);
  assert.deepEqual(slots.map((s) => s.index), [1, 2, 3]);
}));

test("equal link times break ties by account id, so numbering never shuffles", async () => fixture(async dir => {
  await writeStore(dir, {
    "b@x.com": account({ accountId: "b@x.com", addedAt: 100 }),
    "a@x.com": account({ accountId: "a@x.com", addedAt: 100 }),
    "c@x.com": account({ accountId: "c@x.com", addedAt: 100 }),
  });
  assert.deepEqual(readAccountSlots(dir).map((s) => s.accountId), ["a@x.com", "b@x.com", "c@x.com"]);
}));

test("missing, malformed and empty stores degrade to no accounts", async () => fixture(async dir => {
  assert.deepEqual(readAccountSlots(dir), []);
  for (const body of ["{oops", "null", "[]", '{"version":1}', '{"accounts":[]}', '{"accounts":null}']) {
    await writeFile(join(dir, "antigravity-accounts.json"), body);
    assert.deepEqual(readAccountSlots(dir), [], body);
  }
}));

test("an account without an explicit id falls back to its store key", async () => fixture(async dir => {
  await writeStore(dir, { "keyed@x.com": account({ addedAt: 5 }) });
  const slots = readAccountSlots(dir);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].accountId, "keyed@x.com");
  assert.equal(slots[0].provider, "antigravity-1");
}));

// ── Credentials ──────────────────────────────────────────────────────────────

test("each slot's credential envelope carries only its own token", () => {
  const first = credentialEnvelope({ access: "token-one", projectId: "p1", email: "one@x.com" });
  const second = credentialEnvelope({ access: "token-two", projectId: "p2", email: "two@x.com" });
  assert.deepEqual(JSON.parse(first), { token: "token-one", projectId: "p1" });
  assert.deepEqual(JSON.parse(second), { token: "token-two", projectId: "p2" });
  assert.ok(!first.includes("token-two"), "tokens never leak across accounts");
});

test("a missing project id is derived from the account, never left blank", () => {
  const envelope = JSON.parse(credentialEnvelope({ access: "t", email: "user@gmail.com" }));
  assert.equal(envelope.token, "t");
  assert.ok(typeof envelope.projectId === "string" && envelope.projectId.length > 0);
  // Derivation is stable for the same account and differs between accounts.
  const again = JSON.parse(credentialEnvelope({ access: "t", email: "user@gmail.com" }));
  assert.equal(again.projectId, envelope.projectId);
  const other = JSON.parse(credentialEnvelope({ access: "t", email: "other@gmail.com" }));
  assert.notEqual(other.projectId, envelope.projectId);
});

test("freshness reserves a refresh window before expiry", () => {
  assert.equal(slotIsFresh({ access: "t", expires: FUTURE }, NOW), true);
  // Inside the 5 minute skew the token counts as expiring.
  assert.equal(slotIsFresh({ access: "t", expires: NOW + 60_000 }, NOW), false);
  assert.equal(slotIsFresh({ access: "t", expires: NOW + 60_000 }, NOW, 0), true);
  assert.equal(slotIsFresh({ expires: FUTURE }, NOW), false, "no access token is not fresh");
  assert.equal(slotIsFresh({ access: "", expires: FUTURE }, NOW), false);
  assert.equal(slotIsFresh({ access: "t" }, NOW), false, "no expiry is not fresh");
});

test("only a token+project envelope is accepted as a request credential", () => {
  assert.equal(isCredentialEnvelope(credentialEnvelope({ access: "t", projectId: "p" })), true);
  for (const bad of [
    // The registration placeholder Pi hands back is the bug this guards.
    "account-managed", "pool-managed", "pi-local", "", "  ", "{oops",
    JSON.stringify({ token: "t" }),
    JSON.stringify({ projectId: "p" }),
    JSON.stringify({ token: "", projectId: "p" }),
  ]) {
    assert.equal(isCredentialEnvelope(bad), false, JSON.stringify(bad));
  }
  // Leading whitespace is the same JSON document.
  assert.equal(isCredentialEnvelope(` ${JSON.stringify({ token: "t", projectId: "p" })}`), true);
});

// ── Real Pi registration ─────────────────────────────────────────────────────

test("every linked account registers as its own provider in a real session", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-agy-rt-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  let session: any;
  try {
    await writeStore(dir, {
      "one@x.com": account({ accountId: "one@x.com", email: "one@x.com", access: "tok-one",
        expires: Date.now() + 3_600_000, addedAt: 100 }),
      "two@x.com": account({ accountId: "two@x.com", email: "two@x.com", access: "tok-two",
        expires: Date.now() + 3_600_000, addedAt: 200 }),
      "three@x.com": account({ accountId: "three@x.com", email: "three@x.com", access: "tok-three",
        expires: Date.now() + 3_600_000, addedAt: 300 }),
    });
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
    });
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [join(import.meta.dirname, "..", "extensions", "antigravity-accounts.ts")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const manager = SessionManager.create(dir, dir);
    ({ session } = await createAgentSession({
      cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: manager,
    }));
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
    assert.deepEqual(errors, []);

    const rt: any = session.modelRuntime;
    const ids = rt.getProviders()
      .map((provider: any) => provider.id)
      .filter((id: string) => id.startsWith("antigravity-"))
      .sort();
    assert.deepEqual(ids, ["antigravity-1", "antigravity-2", "antigravity-3"],
      "one provider per linked account, no single shared provider");

    for (const id of ids) {
      const chat = rt.getModels(id).filter((model: any) => (model.type ?? "chat") === "chat");
      assert.ok(chat.length > 0, `${id} exposes chat models`);
      assert.equal(rt.hasConfiguredAuth(id), true, `${id} counts as configured`);
      // Models keep Antigravity's API so the vendored stream handles them.
      for (const model of chat) assert.equal(model.api, "antigravity-api");
    }
    // The bare provider id is not registered: the single-account path is gone.
    assert.equal(rt.getProviders().some((provider: any) => provider.id === "antigravity"), false);
  } finally {
    session?.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a session with no linked accounts registers nothing and still loads", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-agy-empty-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  let session: any;
  try {
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
    });
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [join(import.meta.dirname, "..", "extensions", "antigravity-accounts.ts")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const manager = SessionManager.create(dir, dir);
    ({ session } = await createAgentSession({
      cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: manager,
    }));
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
    assert.deepEqual(errors, []);
    const ids = session.modelRuntime.getProviders()
      .map((provider: any) => provider.id)
      .filter((id: string) => id.startsWith("antigravity"));
    assert.deepEqual(ids, []);
  } finally {
    session?.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
