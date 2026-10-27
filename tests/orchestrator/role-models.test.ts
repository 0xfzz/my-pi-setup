import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_POOL,
  ORCH_ROLES,
  modelKey,
  normalizeRoleModels,
  parseBinding,
  parseCommandValue,
  renderAttribution,
  renderBinding,
  renderRoleMenu,
  resolveRoleModel,
  type ModelRegistryPort,
  type RoleModels,
} from "../../lib/orchestrator/role-models.ts";

const registry = (keys: readonly string[], noAuth: readonly string[] = []): ModelRegistryPort => ({
  has: (provider, model) => keys.includes(`${provider}/${model}`),
  hasAuth: (provider, model) => !noAuth.includes(`${provider}/${model}`),
});

const pool = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `p${i}/m${i}`);

test("a binding is inherit, one provider-qualified model, or a pool", () => {
  assert.deepEqual(parseBinding("inherit"), { ok: true, binding: "inherit" });
  assert.deepEqual(parseBinding({ provider: "zai", model: "glm-5.3-flash" }), {
    ok: true,
    binding: { provider: "zai", model: "glm-5.3-flash" },
  });
  assert.deepEqual(parseBinding("zai/glm-5.3-flash"), {
    ok: true,
    binding: { provider: "zai", model: "glm-5.3-flash" },
  });
  assert.deepEqual(parseBinding(["zai/glm-5.3-flash", "deepseek/deepseek-4.1-flash"]), {
    ok: true,
    binding: [
      { provider: "zai", model: "glm-5.3-flash" },
      { provider: "deepseek", model: "deepseek-4.1-flash" },
    ],
  });
});

test("a malformed binding fails closed with a reason", () => {
  assert.match(String((parseBinding("glm-5.3-flash") as any).problems[0]), /provider\/model/);
  assert.match(String((parseBinding(["zai/a", "zai/a"]) as any).problems[0]), /twice/);
  assert.match(String((parseBinding([]) as any).problems[0]), /empty/);
  assert.match(String((parseBinding(pool(MAX_POOL + 1)) as any).problems[0]), /at most 8/);
});

test("persisted settings keep valid roles and drop malformed ones", () => {
  const models = normalizeRoleModels({
    "devil-advocate": "inherit",
    worker: ["zai/glm-5.3-flash"],
    "qa-review": "not-a-model",
    bogus: "inherit",
  });
  assert.deepEqual(models, {
    "devil-advocate": "inherit",
    // A one-member list is the same binding as the single model, so it is
    // normalised to the compact form rather than kept as a 1-item pool.
    worker: { provider: "zai", model: "glm-5.3-flash" },
  });
});

test("the role menu renders exactly the lifecycle shape", () => {
  const models: RoleModels = {
    "devil-advocate": "inherit",
    worker: [
      { provider: "antigravity", model: "gemini-3.8-flash" },
      { provider: "zai", model: "glm-5.3-flash" },
    ],
    "qa-review": "inherit",
  };
  assert.deepEqual(renderRoleMenu(models), [
    "devil-advocate  inherit",
    "worker  [antigravity/gemini-3.8-flash, zai/glm-5.3-flash]",
    "qa-review  inherit",
  ]);
  assert.equal(renderBinding(undefined), "inherit");
  assert.equal(renderBinding({ provider: "zai", model: "glm-5.3-flash" }), "zai/glm-5.3-flash");
  assert.equal(ORCH_ROLES.length, 3);
});

test("a pool rolls once per spawn and always yields a member", () => {
  const keys = ["a/one", "b/two", "c/three"];
  const binding = parseBinding(keys).ok ? (parseBinding(keys) as any).binding : undefined;
  const reg = registry(keys);

  const first = resolveRoleModel({ role: "worker", binding, registry: reg, rng: () => 0 });
  const last = resolveRoleModel({ role: "worker", binding, registry: reg, rng: () => 0.999 });
  assert.equal(first.model, "a/one");
  assert.equal(last.model, "c/three");
  assert.equal(first.poolSize, 3);
  assert.ok(keys.includes(String(first.model)));
  assert.equal(first.source, "role");
});

test("precedence: explicit beats the role binding, which beats the defaults", () => {
  const reg = registry(["zai/glm-5.3-flash", "agent/one", "global/two"]);
  const binding = parseBinding("zai/glm-5.3-flash");

  const explicit = resolveRoleModel({
    role: "worker",
    binding: (binding as any).binding,
    explicit: "agent/one",
    registry: reg,
    agentDefault: "global/two",
    globalDefault: "global/two",
  });
  assert.equal(explicit.model, "agent/one");
  assert.equal(explicit.source, "explicit");

  const role = resolveRoleModel({ role: "worker", binding: (binding as any).binding, registry: reg });
  assert.equal(role.model, "zai/glm-5.3-flash");
  assert.equal(role.source, "role");

  const inherited = resolveRoleModel({ role: "worker", binding: "inherit", registry: reg, agentDefault: "agent/one" });
  assert.equal(inherited.model, undefined, "inherit follows the parent even when a default exists");
  assert.equal(inherited.source, "role");

  assert.equal(resolveRoleModel({ role: "worker", registry: reg, agentDefault: "agent/one" }).source, "agent");
  assert.equal(resolveRoleModel({ role: "worker", registry: reg, globalDefault: "global/two" }).source, "global");
  assert.equal(resolveRoleModel({ role: "worker", registry: reg }).source, "default");
});

test("a vanished model falls back instead of failing the spawn", () => {
  const reg = registry(["zai/glm-5.3-flash"]);
  const binding = parseBinding(["gone/model", "zai/glm-5.3-flash", "also-gone/model"]);
  const resolved = resolveRoleModel({ role: "worker", binding: (binding as any).binding, registry: reg, rng: () => 0 });
  assert.equal(resolved.model, "zai/glm-5.3-flash");
  assert.equal(resolved.poolSize, 1);
  assert.match(resolved.notes.join(" "), /gone\/model no longer resolves/);
});

test("a fully unresolvable pool follows the parent and says so", () => {
  const reg = registry([]);
  const binding = parseBinding(["gone/a", "gone/b"]);
  const resolved = resolveRoleModel({ role: "qa-review", binding: (binding as any).binding, registry: reg });
  assert.equal(resolved.model, undefined);
  assert.match(resolved.notes.join(" "), /did not resolve/);
});

test("a model without credentials is used but warned about", () => {
  const reg = registry(["zai/glm-5.3-flash"], ["zai/glm-5.3-flash"]);
  const binding = parseBinding("zai/glm-5.3-flash");
  const resolved = resolveRoleModel({ role: "worker", binding: (binding as any).binding, registry: reg });
  assert.equal(resolved.model, "zai/glm-5.3-flash");
  assert.match(renderAttribution(resolved), /no credentials/);
});

test("attribution names the model and why it was chosen", () => {
  assert.equal(
    renderAttribution({ role: "worker", model: "zai/glm-5.3-flash", source: "role", poolSize: 3, notes: [] }),
    "zai/glm-5.3-flash — rolled from a 3-model worker pool",
  );
  assert.equal(
    renderAttribution({ role: "worker", model: "zai/glm-5.3-flash", source: "role", poolSize: 1, notes: [] }),
    "zai/glm-5.3-flash — worker binding",
  );
  assert.equal(
    renderAttribution({ role: "qa-review", source: "role", notes: [] }),
    "inherit (parent) — qa-review binding",
  );
});

test("the text command resolves a bare id only when it is unambiguous", () => {
  const known = ["zai/glm-5.3-flash", "deepseek/deepseek-4.1-flash", "openrouter/glm-5.3-flash"];

  assert.deepEqual(parseCommandValue("inherit", known), { ok: true, binding: "inherit" });
  assert.equal(parseCommandValue("zai/glm-5.3-flash,deepseek/deepseek-4.1-flash", known).ok, true);

  const unique = parseCommandValue("deepseek-4.1-flash", known);
  assert.deepEqual(unique, { ok: true, binding: { provider: "deepseek", model: "deepseek-4.1-flash" } });

  assert.match(String((parseCommandValue("glm-5.3-flash", known) as any).problems[0]), /ambiguous/);
  assert.match(String((parseCommandValue("nope", known) as any).problems[0]), /not a model/);
  assert.match(String((parseCommandValue("inherit,zai/glm-5.3-flash", known) as any).problems[0]), /inherit alone/);
  assert.match(String((parseCommandValue("zai/glm-5.3-flash,zai/glm-5.3-flash", known) as any).problems[0]), /twice/);
});

test("modelKey keeps model ids that contain slashes intact", () => {
  assert.equal(modelKey({ provider: "openrouter", model: "meta-llama/llama-3" }), "openrouter/meta-llama/llama-3");
});
