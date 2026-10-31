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

// ---- sandbox ask lane (`sandbox.ask: "refusal"`) -----------------------------

test("bashAskLane refusal suppresses the bash pre-flight ask; the kernel asks instead", async () => {
  const records: any[] = [];
  const h = harness([], {}, {
    bashAskLane: () => "refusal",
    sandbox: () => ({ backend: "landlock", mode: "workspace" }),
    onDecision: r => records.push(r),
  });

  const result = await h.gate.gate("bash", { command: "touch /srv/outside/x" });
  assert.equal(result, undefined, "bash runs: the armed sandbox is the boundary");
  assert.equal(h.asked.length, 0, "no pre-flight question");
  const record = records.at(-1)!;
  assert.equal(record.tool, "bash");
  assert.equal(record.effect, "allow");
  assert.match(record.reason ?? "", /sandbox refusal mode/);
  assert.deepEqual(record.sandbox, { backend: "landlock", mode: "workspace" });
});

test("a configured deny still blocks under the refusal lane and never asks", async () => {
  const h = harness([], {
    rules: [{ action: "bash", resource: "/srv/blocked/*", effect: "deny" }],
  }, {
    bashAskLane: () => "refusal",
  });

  const result = await h.gate.gate("bash", { command: "touch /srv/blocked/x" });
  assert.ok(result?.block, "deny wins over the lane");
  assert.equal(h.asked.length, 0);
});

test("the opaque-command ask is suppressed under the refusal lane for bash only", async () => {
  const h = harness([], {}, { bashAskLane: () => "refusal" });
  const result = await h.gate.gate("bash", { command: "bash -c 'touch /srv/x'" });
  assert.equal(result, undefined);
  assert.equal(h.asked.length, 0);

  // Another tool is untouched.
  const h2 = harness([], {}, { bashAskLane: () => "refusal" });
  const blocked = await h2.gate.gate("bash", { command: "bash -c 'touch /srv/y'" });
  assert.equal(blocked, undefined);
});

test("decision records carry no sandbox key when the sandbox is bare", async () => {
  const records: any[] = [];
  const h = harness([], {}, {
    bashAskLane: () => "refusal",
    sandbox: () => undefined,
    onDecision: r => records.push(r),
  });

  await h.gate.gate("bash", { command: "touch /srv/outside/x" });
  assert.equal(records.at(-1)!.sandbox, undefined);
});

// ---- the refusal answer must reach the kernel ------------------------------

test("an armed boundary turns a temp refusal into a real question", async () => {
  const h = harness([{ kind: "once" }], {}, { sandboxBoundary: () => ({ writable: [], deny: [] }) });
  const outcome = await h.gate.handleRefusal("bash", "/tmp/agent-out.txt");

  assert.equal(h.asked.length, 1, "/tmp asks once a kernel boundary is armed");
  assert.equal(outcome.allowed, true);
  assert.deepEqual(outcome.granted, ["/tmp"], "the parent directory is what the kernel needs to create the file");
  assert.equal(outcome.retrySafe, true);
});

test("a rule the gate already trusts still widens the wrap so the retry can succeed", async () => {
  const h = harness([], { rules: [{ action: "bash", resource: "/srv/data/*", effect: "allow" }] });
  const outcome = await h.gate.handleRefusal("bash", "/srv/data/out.txt");

  assert.equal(outcome.allowed, true);
  assert.equal(h.asked.length, 0, "an allow rule still does not ask");
  assert.deepEqual(outcome.granted, ["/srv/data"]);
  assert.equal(outcome.retrySafe, true, "an approval the kernel never hears must not be sold as a retry");
});

test("a rule answer cannot widen the kernel, so it is not retry-safe", async () => {
  const h = harness([{ kind: "rule", text: "bash /srv/data/* allow" }]);
  const outcome = await h.gate.handleRefusal("bash", "/srv/data/out.txt");

  assert.equal(outcome.allowed, true);
  assert.deepEqual(outcome.granted, [], "a gate rule is not a sandbox grant");
  assert.equal(outcome.retrySafe, false);
});

test("a deny answer is never retry-safe", async () => {
  const h = harness([{ kind: "deny" }]);
  const outcome = await h.gate.handleRefusal("bash", "/srv/data/out.txt");

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.retrySafe, false);
});

test("a deny rule refuses the refusal lane with no dialog and no retry", async () => {
  const h = harness([], { rules: [{ action: "bash", resource: "/srv/blocked/*", effect: "deny" }] });
  const outcome = await h.gate.handleRefusal("bash", "/srv/blocked/x.txt");

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.retrySafe, false);
  assert.equal(h.asked.length, 0);
});
