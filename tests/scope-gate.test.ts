import assert from "node:assert/strict";
import { test } from "node:test";
import { createGate, parseRule, type AskAnswer, type AskRequest, type GateDeps } from "../lib/scope/gate.ts";
import { DEFAULT_SCOPE_DEFAULTS, type ScopeRoot, type ScopeState } from "../lib/scope/types.ts";

const cwd = "/work";

function harness(
  script: Array<AskAnswer | undefined | Error>,
  defaults = { external: "ask", readExternal: "ask" } as ScopeState["defaults"],
  extra: Partial<GateDeps> = {},
) {
  const state: ScopeState = {
    roots: [{ path: cwd, access: "rw", source: "session" }],
    rules: [],
    defaults,
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

test("a path inside the workspace never asks", async () => {
  const h = harness([]);
  assert.equal(await h.gate.gate("read", { path: "src/a.ts" }), undefined);
  assert.deepEqual(h.asked, []);
});

test("with the shipped defaults an outside read runs without a dialog", async () => {
  const h = harness([], DEFAULT_SCOPE_DEFAULTS);
  assert.equal(await h.gate.gate("read", { path: "/etc/os-release" }), undefined);
  assert.deepEqual(h.asked, [], "reads are open by default");

  const write = await h.gate.gate("write", { path: "/etc/motd" });
  assert.equal(write?.block, true, "an outside write still asks, and no answer blocks");
  assert.equal(h.asked.length, 1);
});

test("an outside read asks once and the answer covers only that call", async () => {
  const h = harness([{ kind: "once" }, { kind: "deny" }]);
  assert.equal(await h.gate.gate("read", { path: "../other/a.ts" }), undefined);
  assert.equal(h.asked.length, 1);
  assert.equal(h.asked[0]?.display, "/other/a.ts", "external targets are shown absolutely, never cwd-relative");
  assert.equal(h.asked[0]?.write, false);
  assert.match(h.asked[0]?.reason ?? "", /outside the workspace/);

  const blocked = await h.gate.gate("read", { path: "../other/a.ts" });
  assert.equal(blocked?.block, true, "allow once must not become a standing grant");
  assert.equal(h.state.roots.length, 1);
});

test("allow this folder adds a session root and stops asking for its files", async () => {
  const h = harness([{ kind: "allow", grant: { path: "/other", access: "ro", glob: "/other/*", exact: false } }]);
  assert.equal(await h.gate.gate("read", { path: "../other/a.ts" }), undefined);
  assert.equal(h.state.roots.length, 2);
  assert.deepEqual(h.grants.map(root => root?.path), ["/other"]);

  assert.equal(await h.gate.gate("read", { path: "../other/b.ts" }), undefined);
  assert.equal(h.asked.length, 1, "the folder grant must cover its siblings");
});

test("a workspace answer adds the root and asks the caller to persist it", async () => {
  const persisted: string[] = [];
  const grant = { path: "/other", access: "rw" as const, glob: "/other/*", exact: false };
  const h = harness(
    [{ kind: "allow", grant, persist: "workspace" }],
    { external: "ask", readExternal: "ask" },
    { onPersistGrant: suggestion => persisted.push(suggestion.path) },
  );
  assert.equal(await h.gate.gate("write", { path: "/other/a.txt" }), undefined);
  assert.deepEqual(persisted, ["/other"], "the caller is the only one that knows where the project config is");
  assert.deepEqual(h.grants.map(root => root?.path), ["/other"], "the session root is still recorded for the call in flight");
  assert.equal(h.state.roots.length, 2);
});

test("a session answer never asks the caller to persist anything", async () => {
  const persisted: string[] = [];
  const h = harness(
    [{ kind: "allow", grant: { path: "/other", access: "ro", glob: "/other/*", exact: false } }],
    { external: "ask", readExternal: "ask" },
    { onPersistGrant: suggestion => persisted.push(suggestion.path) },
  );
  assert.equal(await h.gate.gate("read", { path: "/other/a.txt" }), undefined);
  assert.deepEqual(persisted, []);
});

test("a second answer upgrades a read-only root to read-write", async () => {
  // Otherwise "allow read-write" on a folder already granted read-only would
  // change nothing, and the write would ask again forever.
  const h = harness([
    { kind: "allow", grant: { path: "/other", access: "ro", glob: "/other/*", exact: false } },
    { kind: "allow", grant: { path: "/other", access: "rw", glob: "/other/*", exact: false } },
  ], { external: "ask", readExternal: "ask" });
  await h.gate.gate("read", { path: "/other/a.txt" });
  assert.equal(await h.gate.gate("write", { path: "/other/a.txt" }), undefined);
  assert.equal(h.state.roots.length, 2, "an upgrade must not stack a second root");
  assert.equal(h.state.roots.find(root => root.path === "/other")?.access, "rw");
  assert.deepEqual(h.grants.map(root => root?.access), ["ro", "rw"]);
});

test("a folder grant is read-only until a write asks for read-write", async () => {
  const h = harness([
    { kind: "allow", grant: { path: "/other", access: "ro", glob: "/other/*", exact: false } },
    { kind: "deny" },
  ]);
  await h.gate.gate("read", { path: "../other/a.ts" });
  const write = await h.gate.gate("write", { path: "../other/a.ts" });
  assert.equal(write?.block, true, "a read-only root must not silently allow a write");
  assert.equal(h.asked.length, 2);
  assert.equal(h.asked[1]?.write, true);
  assert.equal(h.asked[1]?.suggestion.access, "rw");
});

test("a queued call covered by an earlier folder grant never opens a second dialog", async () => {
  const h = harness([{ kind: "allow", grant: { path: "/other", access: "ro", glob: "/other/*", exact: false } }]);
  const results = await Promise.all([
    h.gate.gate("read", { path: "../other/a.ts" }),
    h.gate.gate("read", { path: "../other/b.ts" }),
  ]);
  assert.deepEqual(results, [undefined, undefined]);
  assert.equal(h.asked.length, 1, "one folder grant, one question, two calls");
});

test("a deny blocks the call with a model-facing reason and stores nothing", async () => {
  const h = harness([{ kind: "deny" }]);
  const result = await h.gate.gate("read", { path: "/etc/passwd" });
  assert.equal(result?.block, true);
  assert.match(result!.reason, /denied access to \/etc\/passwd/);
  assert.match(result!.reason, /\/scope allow/);
  assert.equal(h.state.roots.length, 1);
});

test("a deny with a note reaches the model as an instruction", async () => {
  const h = harness([{ kind: "deny", feedback: "read config.yaml inside /work instead" }]);
  const result = await h.gate.gate("read", { path: "/etc/passwd" });
  assert.equal(result?.block, true);
  assert.match(result!.reason, /Do this instead: read config\.yaml inside \/work instead/);
  assert.doesNotMatch(result!.reason, /\/scope allow/, "the note replaces the generic hint rather than competing with it");
  assert.equal(result!.feedback, "read config.yaml inside /work instead");
});

test("a plain deny carries no instruction", async () => {
  const h = harness([{ kind: "deny" }]);
  const result = await h.gate.gate("read", { path: "/etc/passwd" });
  assert.equal(result?.block, true);
  assert.equal(result!.feedback, undefined);
  assert.doesNotMatch(result!.reason, /Do this instead/);
});

test("a rule answer is parsed, applied and re-evaluated before the call runs", async () => {
  const h = harness([{ kind: "rule", text: "read /secrets/* deny" }]);
  const denied = await h.gate.gate("read", { path: "/secrets/key" });
  assert.equal(denied?.block, true);
  assert.equal(h.state.rules.length, 1);

  const permissive = harness([{ kind: "rule", text: "read /other/* allow" }]);
  assert.equal(await permissive.gate.gate("read", { path: "/other/a.ts" }), undefined);
  assert.equal(await permissive.gate.gate("read", { path: "/other/b.ts" }), undefined);
  assert.equal(permissive.asked.length, 1);
});

test("a failed or unavailable dialog denies; it never approves", async () => {
  const failed = harness([new Error("UI exploded")]);
  assert.equal((await failed.gate.gate("read", { path: "/etc/passwd" }))?.block, true);

  const unavailable = harness([{ kind: "unavailable", message: "Scope: no UI. Grant with /scope allow /etc/x." }]);
  const result = await unavailable.gate.gate("read", { path: "/etc/x" });
  assert.equal(result?.reason, "Scope: no UI. Grant with /scope allow /etc/x.");

  const empty = harness([undefined]);
  assert.equal((await empty.gate.gate("read", { path: "/etc/passwd" }))?.block, true);
});

test("a tool outside the gate's jurisdiction bypasses it without asking", async () => {
  const h = harness([]);
  // MCP is the case that matters: its inputs belong to the server, so the gate
  // declines jurisdiction instead of inventing a path or a consent state.
  for (const tool of ["mcp__private", "mcp__fs", "code_read", "shell_read", "brand_new"]) {
    assert.equal(await h.gate.gate(tool, { file: "../x" }), undefined, tool);
  }
  assert.deepEqual(h.asked, [], "a bypass is not a question and not a grant");
  assert.deepEqual(h.grants, []);
});

test("an opaque shell construct still asks once, and a rule for bash silences it", async () => {
  const denied = harness([{ kind: "deny" }]);
  const blocked = await denied.gate.gate("bash", { command: "bash -c 'rm -rf /'" });
  assert.equal(blocked?.block, true);
  assert.equal(denied.asked.length, 1, "the construct is named and asked once");

  const ruled = harness([{ kind: "rule", text: "bash * allow" }]);
  assert.equal(await ruled.gate.gate("bash", { command: "bash -c 'echo hi'" }), undefined, "the rule answer lets this call run");
  assert.equal(await ruled.gate.gate("bash", { command: "bash -c 'echo bye'" }), undefined, "and it covers later opaque calls");
  assert.equal(ruled.asked.length, 1, "so the same class of command asks once");
});

test("an opaque command names the narrowest rule instead of a blanket one", async () => {
  const h = harness([]);
  const result = await h.gate.gate("bash", { command: "find . -exec rm {} ;" });
  assert.equal(result?.block, true);
  assert.match(result!.reason, /"resource":"find \*"/, "the narrow rule is what the model is told to ask for");
  assert.doesNotMatch(result!.reason, /"resource":"\*"/, "the old blanket bash rule must not be suggested");
});

test("bash -c cannot be narrowed, so no standing grant is offered at all", async () => {
  // Every rule this construct could produce is tool-wide, so the honest answer is
  // to restructure rather than to sell a blanket grant.
  const h = harness([]);
  const result = await h.gate.gate("bash", { command: "bash -c 'rm -rf /'" });
  assert.equal(result?.block, true);
  assert.doesNotMatch(result!.reason, /"resource":"\*"/);
  assert.match(result!.reason, /restructure/i);
});

test("the gate judges a bash call against the directory the prefix selects", async () => {
  // Pi prepends the configured prefix, so a `cd` there is where the command runs;
  // the claim's base must be that directory, not the session cwd.
  const h = harness([], DEFAULT_SCOPE_DEFAULTS, { baseFor: () => ({ base: "/other/repo" }) });
  const claim = h.gate.claimsFor("bash", { command: "cat ../data.txt" });
  assert.equal(claim.paths[0]?.base, "/other/repo");
});

test("an unreadable prefix makes the call unjudgeable instead of silently wrong", async () => {
  const h = harness([], DEFAULT_SCOPE_DEFAULTS, {
    baseFor: () => ({ base: cwd, opaque: "the shell command prefix could not be analysed" }),
  });
  const result = await h.gate.gate("bash", { command: "ls" });
  assert.equal(result?.block, true);
  assert.match(result!.reason, /prefix could not be analysed/);
});

test("a non-bash tool is never re-based by the shell prefix", () => {
  const h = harness([], DEFAULT_SCOPE_DEFAULTS, { baseFor: () => ({ base: "/other/repo" }) });
  const claim = h.gate.claimsFor("read", { path: "src/a.ts" });
  assert.equal(claim.paths[0]?.raw, "src/a.ts");
  assert.equal(claim.paths[0]?.base, undefined);
});

test("bash claims are judged per path and a denial stops the whole call", async () => {
  const h = harness([{ kind: "deny" }]);
  assert.equal(await h.gate.gate("bash", { command: "cat src/a.ts && ls" }), undefined);
  assert.equal(h.asked.length, 0, "an all-inside command never asks");

  const outside = harness([{ kind: "once" }, { kind: "deny" }]);
  const result = await outside.gate.gate("bash", { command: "cp /etc/a.ts /var/b.ts" });
  assert.equal(result?.block, true);
  assert.equal(outside.asked.length, 2, "each outside path is asked about, and the deny wins");
});

test("a policy hook can tighten an allow and relax an ask", async () => {
  const tightened = harness([{ kind: "deny" }], DEFAULT_SCOPE_DEFAULTS, { onEvaluate: () => "ask" });
  assert.equal((await tightened.gate.gate("read", { path: "src/a.ts" }))?.block, true);
  assert.equal(tightened.asked.length, 1, "an inside read became a question because policy said so");

  const relaxed = harness([], { external: "ask", readExternal: "ask" }, { onEvaluate: () => "allow" });
  assert.equal(await relaxed.gate.gate("read", { path: "/etc/passwd" }), undefined);
  assert.deepEqual(relaxed.asked, [], "policy allowed what the table would have asked");
});

test("a policy hook can never re-open a deny", async () => {
  // The hook fires on the in-lane recheck too, so it must stay quiet until the
  // rule exists — otherwise it relaxes the very question that installs the rule.
  let installed = false;
  const h = harness(
    [{ kind: "rule", text: "read /secrets/* deny" }],
    { external: "ask", readExternal: "ask" },
    { onEvaluate: () => (installed ? "allow" : undefined) },
  );
  await h.gate.gate("read", { path: "/secrets/key" });
  assert.equal(h.state.rules.length, 1, "the rule answer was recorded");
  installed = true;

  const blocked = await h.gate.gate("read", { path: "/secrets/key" });
  assert.equal(blocked?.block, true, "deny is absolute: no hook re-opens it");
  assert.equal(h.asked.length, 1, "and it does not even ask again");
});

test("a throwing policy hook keeps the decision instead of approving", async () => {
  const h = harness([], { external: "ask", readExternal: "ask" }, {
    onEvaluate: () => { throw new Error("policy exploded"); },
  });
  const result = await h.gate.gate("read", { path: "/etc/passwd" });
  assert.equal(result?.block, true, "a crashing hook must not become a silent allow");
  assert.equal(h.asked.length, 1);
});

test("the same rule answer twice is stored once", async () => {
  const h = harness(
    [{ kind: "rule", text: "read /other/* deny" }, { kind: "rule", text: "read /other/* deny" }],
    { external: "ask", readExternal: "ask" },
  );
  await h.gate.gate("read", { path: "/other/a.ts" });
  await h.gate.gate("read", { path: "/second/a.ts" });
  assert.equal(h.state.rules.length, 1, "a repeated answer must not stack a duplicate that later shadows it");
});

test("parseRule accepts tool/resource/effect and falls back to the claim's resource", () => {
  assert.deepEqual(parseRule("bash rm * deny", "/x"), { action: "bash", resource: "rm *", effect: "deny" });
  assert.deepEqual(parseRule("/other/* allow", "/x"), { action: "*", resource: "/other/*", effect: "allow" });
  assert.deepEqual(parseRule("ask", "/x"), { action: "*", resource: "/x", effect: "ask" });
  assert.throws(() => parseRule("nonsense", "/x"), /Cannot read rule/);
});
