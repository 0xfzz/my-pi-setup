import assert from "node:assert/strict";
import { test } from "node:test";
import { createGate, type AskAnswer, type AskRequest, type GateDeps } from "../lib/scope/gate.ts";
import { canonicalize } from "../lib/scope/paths.ts";
import { DEFAULT_SCOPE_DEFAULTS, type ScopeRoot, type ScopeState } from "../lib/scope/types.ts";

const cwd = canonicalize("/work");

function harness(
  script: Array<AskAnswer | undefined | Error>,
  initialState: Partial<ScopeState> = {},
  extra: Partial<GateDeps> = {},
) {
  const state: ScopeState = {
    roots: [{ path: cwd, access: "rw", source: "session" }],
    rules: [],
    defaults: { ...DEFAULT_SCOPE_DEFAULTS },
    ...initialState,
  };

  const asked: AskRequest[] = [];
  const grants: Array<ScopeRoot | undefined> = [];
  let current = state;

  const gate = createGate({
    cwd: () => cwd,
    state: () => current,
    setState: next => { current = next; },
    ask: async request => {
      asked.push(request);
      const next = script.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    onGrant: grant => grants.push(grant.root),
    ...extra,
  });

  return { gate, asked, grants, get state() { return current; } };
}

test("handleRefusal immediately refuses a path blocked by a deny rule without asking", async () => {
  const h = harness([], {
    rules: [{ action: "bash", resource: "/srv/blocked/*", effect: "deny" }],
  });

  const outcome = await h.gate.handleRefusal("bash", "/srv/blocked/target.txt");
  assert.equal(outcome.allowed, false);
  assert.match(outcome.reason ?? "", /rule bash:\/srv\/blocked\/\*/);
  assert.equal(h.asked.length, 0, "a configured deny must never ask the user");
});

test("handleRefusal automatically allows a path when yolo rw is armed", async () => {
  const h = harness([], {
    yolo: { strength: "rw", persist: false, since: Date.now() },
  });

  const outcome = await h.gate.handleRefusal("bash", "/srv/data/file.txt");
  assert.equal(outcome.allowed, true);
  assert.equal(h.asked.length, 0, "yolo rw must not open a question dialog");
});

test("handleRefusal opens dialog on outside path and applies allow answer", async () => {
  const targetPath = canonicalize("/srv/data/file.txt");
  const targetDir = canonicalize("/srv/data");

  const h = harness([
    {
      kind: "allow",
      grant: { path: targetDir, access: "rw", glob: `${targetDir}/*`, exact: false },
    },
  ]);

  const outcome = await h.gate.handleRefusal("bash", targetPath);
  assert.equal(outcome.allowed, true);
  assert.match(outcome.grantSummary ?? "", /allowed for this folder/);
  assert.equal(h.asked.length, 1);
  assert.equal(h.asked[0]?.absolute, targetPath);

  // Assert that state now includes the newly granted root
  assert.ok(h.state.roots.some(r => r.path === targetDir && r.access === "rw"));
});

test("handleRefusal returns denial reason when user denies", async () => {
  const targetPath = canonicalize("/srv/secret/file.txt");
  const h = harness([
    { kind: "deny", feedback: "Use the local mock instead" },
  ]);

  const outcome = await h.gate.handleRefusal("bash", targetPath);
  assert.equal(outcome.allowed, false);
  assert.match(outcome.reason ?? "", /Use the local mock instead/);
  assert.equal(h.asked.length, 1);
});

test("handleRefusal escalates in delegated child sessions instead of opening dialog", async () => {
  const targetPath = canonicalize("/srv/shared/out.txt");
  const h = harness([], {}, { isChild: () => true });

  const outcome = await h.gate.handleRefusal("bash", targetPath);
  assert.equal(outcome.allowed, false);
  assert.match(outcome.reason ?? "", /ask your parent with agent_ping/);
  assert.equal(h.asked.length, 0, "child session must not prompt user");
});
