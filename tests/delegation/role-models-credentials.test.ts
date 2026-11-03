import test from "node:test";
import assert from "node:assert/strict";
import { resolveRoleModel, type ModelRegistryPort } from "../../lib/delegation/role-models.ts";

function registry(opts: { registered: string[]; authed: string[] }): ModelRegistryPort {
  return {
    has: (provider, model) => opts.registered.includes(`${provider}/${model}`),
    hasAuth: (provider, model) => opts.authed.includes(`${provider}/${model}`),
  };
}

const pool = [
  { provider: "router", model: "ag-route-1" },
  { provider: "opencode", model: "deepseek-v4.1-flash-free" },
  { provider: "opencode", model: "glm-5.3-flash-free" },
];

test("a pool rolls only among members that have credentials", () => {
  // Regression: the roll picked a member with no credentials and launched a child
  // that could not start; the warning was only a note.
  const reg = registry({
    registered: pool.map((r) => `${r.provider}/${r.model}`),
    authed: ["router/ag-route-1"],
  });
  for (const roll of [0, 0.5, 0.99]) {
    const r = resolveRoleModel({ role: "worker", binding: pool, registry: reg, rng: () => roll });
    assert.equal(r.model, "router/ag-route-1");
    assert.equal(r.problem, undefined);
    assert.ok(r.notes.some((n) => n.includes("skipped")));
  }
});

test("a pool with no credentialed member is a refusal, not a launch", () => {
  const reg = registry({ registered: pool.map((r) => `${r.provider}/${r.model}`), authed: [] });
  const r = resolveRoleModel({ role: "worker", binding: pool, registry: reg, rng: () => 0 });
  assert.ok(r.problem, "expected a problem");
  assert.match(r.problem!, /has credentials, so a child cannot start/);
  assert.equal(r.model, undefined);
});

test("an explicit model without credentials is refused", () => {
  const reg = registry({ registered: ["opencode/glm-5.3-flash-free"], authed: [] });
  const r = resolveRoleModel({ role: "worker", explicit: "opencode/glm-5.3-flash-free", registry: reg });
  assert.match(r.problem ?? "", /no credentials/);
});

test("an explicit model with credentials is admitted", () => {
  const reg = registry({ registered: ["opencode/glm-5.3-flash-free"], authed: ["opencode/glm-5.3-flash-free"] });
  const r = resolveRoleModel({ role: "worker", explicit: "opencode/glm-5.3-flash-free", registry: reg });
  assert.equal(r.problem, undefined);
  assert.equal(r.model, "opencode/glm-5.3-flash-free");
});

test("a pool whose members are all unregistered still follows the parent, as before", () => {
  const reg = registry({ registered: [], authed: [] });
  const r = resolveRoleModel({ role: "worker", binding: pool, registry: reg, rng: () => 0 });
  assert.equal(r.problem, undefined);
  assert.equal(r.model, undefined);
});
