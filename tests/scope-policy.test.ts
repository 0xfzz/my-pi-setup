import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateClaim } from "../lib/scope/policy.ts";
import {
  DEFAULT_SCOPE_DEFAULTS,
  type PathClaim,
  type ScopeRoot,
  type ScopeRule,
  type ScopeState,
} from "../lib/scope/types.ts";

const root = (path: string, access: "ro" | "rw" = "rw"): ScopeRoot => ({ path, access, source: "session" });
const rule = (action: string, resource: string, effect: "allow" | "ask" | "deny"): ScopeRule => ({ action, resource, effect });

function state(overrides: Partial<ScopeState> = {}): ScopeState {
  return { roots: [root("/work")], rules: [], defaults: DEFAULT_SCOPE_DEFAULTS, ...overrides };
}

/** The same state with both outside defaults questioning, for dialog-flow tests. */
const asking = { external: "ask", readExternal: "ask", unknown: "ask" } as const;

function claim(overrides: Partial<PathClaim> = {}): PathClaim {
  return {
    tool: "read",
    action: "read",
    absolute: "/work/src/a.ts",
    resource: "src/a.ts",
    write: false,
    external: false,
    kind: "file",
    ...overrides,
  };
}

const outside = () => claim({ absolute: "/other/a.ts", resource: "/other/a.ts", external: true });

test("inside the workspace is allowed with no rule and no dialog", () => {
  const decision = evaluateClaim(claim(), state());
  assert.equal(decision.effect, "allow");
  assert.equal(decision.root?.path, "/work");
});

test("a deny rule outranks a root, an allow rule and yolo", () => {
  const rules = [rule("read", "*", "allow"), rule("read", "secrets/*", "deny")];
  for (const yolo of [undefined, { strength: "rw" as const, persist: false, since: 0 }]) {
    const decision = evaluateClaim(
      claim({ absolute: "/work/secrets/a.ts", resource: "secrets/a.ts" }),
      state({ rules, yolo }),
    );
    assert.equal(decision.effect, "deny");
    assert.match(decision.reason, /denied/i);
  }
});

test("external_directory rules can deny the boundary without denying the tool", () => {
  const rules = [rule("external_directory", "/other/*", "deny")];
  const decision = evaluateClaim(outside(), state({ rules }));
  assert.equal(decision.effect, "deny");
  assert.match(decision.reason, /external_directory/);
});

test("a read-only root allows reads and refuses to become a write target", () => {
  const ro = state({ roots: [root("/work"), root("/work/vendor", "ro")] });
  const read = evaluateClaim(claim({ absolute: "/work/vendor/a.ts", resource: "vendor/a.ts" }), ro);
  assert.equal(read.effect, "allow");
  assert.equal(read.root?.access, "ro");

  const write = evaluateClaim(
    claim({ tool: "write", action: "write", write: true, absolute: "/work/vendor/a.ts", resource: "vendor/a.ts" }),
    ro,
  );
  assert.equal(write.effect, "ask");
  assert.match(write.reason, /read-only/);
});

test("outside the workspace gates writes and opens reads by default", () => {
  // Claude Code, Codex CLI and Cline all gate writes and leave reads open: a gate
  // that asks about `cat /etc/os-release` is one people disable.
  assert.equal(evaluateClaim(outside(), state()).effect, "allow", "an outside read is open");
  const write = claim({ tool: "write", action: "write", write: true, external: true, absolute: "/other/a.ts", resource: "/other/a.ts" });
  assert.equal(evaluateClaim(write, state()).effect, "ask", "an outside write still asks");
  assert.equal(evaluateClaim(write, state({ defaults: { ...asking, external: "deny" } })).effect, "deny");
  assert.equal(evaluateClaim(outside(), state({ defaults: { ...asking, readExternal: "deny" } })).effect, "deny");
});

test("approved once permits exactly the call it was granted for", () => {
  const gated = state({ defaults: asking });
  assert.equal(evaluateClaim(outside(), gated, { approvedOnce: true }).effect, "allow");
  assert.equal(evaluateClaim(outside(), gated).effect, "ask", "the grant is not stored in the state");
});

test("a root added after the question was queued covers the pending claim", () => {
  const granted = state({ roots: [root("/work"), root("/other")], defaults: asking });
  const decision = evaluateClaim(outside(), granted);
  assert.equal(decision.effect, "allow");
  assert.equal(decision.root?.path, "/other");
  assert.equal(evaluateClaim(outside(), state({ defaults: asking })).effect, "ask");
});

test("yolo upgrades a question, respects its strength, and never touches a deny", () => {
  const read = claim({ absolute: "/other/a.ts", resource: "/other/a.ts", external: true });
  const write = claim({ tool: "write", action: "write", write: true, absolute: "/other/a.ts", resource: "/other/a.ts", external: true });

  const ro = state({ yolo: { strength: "ro", persist: false, since: 0 } });
  assert.equal(evaluateClaim(read, ro).effect, "allow");
  assert.equal(evaluateClaim(write, ro).effect, "ask", "yolo ro must not approve writes");
  assert.match(evaluateClaim(write, ro).reason, /yolo ro/);

  const rw = state({ yolo: { strength: "rw", persist: false, since: 0 } });
  assert.equal(evaluateClaim(write, rw).effect, "allow");
  assert.match(evaluateClaim(write, rw).reason, /yolo rw/);

  const denied = state({ yolo: { strength: "rw", persist: false, since: 0 }, rules: [rule("*", "/other/*", "deny")] });
  assert.equal(evaluateClaim(write, denied).effect, "deny");
});

test("a tool with unmapped inputs follows defaults.unknown, and yolo ro leaves it asking", () => {
  const unknown = { tool: "mcp__private", unknown: true as const };
  assert.equal(evaluateClaim(unknown, state()).effect, "ask");
  assert.equal(evaluateClaim(unknown, state({ defaults: { external: "ask", readExternal: "allow", unknown: "deny" } })).effect, "deny");
  assert.equal(
    evaluateClaim(unknown, state({ yolo: { strength: "ro", persist: false, since: 0 } })).effect,
    "ask",
    "an unmapped tool may write, so read-only yolo must not approve it",
  );
  assert.equal(
    evaluateClaim(unknown, state({ yolo: { strength: "rw", persist: false, since: 0 } })).effect,
    "allow",
  );
});
