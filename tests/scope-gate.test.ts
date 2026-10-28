import assert from "node:assert/strict";
import { test } from "node:test";
import { createGate, parseRule, type AskAnswer, type AskRequest } from "../lib/scope/gate.ts";
import { DEFAULT_SCOPE_DEFAULTS, type ScopeRoot, type ScopeState } from "../lib/scope/types.ts";

const cwd = "/work";

function harness(script: Array<AskAnswer | undefined | Error>, defaults = { external: "ask", readExternal: "ask", unknown: "ask" } as ScopeState["defaults"]) {
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

test("an unknown tool asks; only allow-once can approve it", async () => {
  const once = harness([{ kind: "once" }]);
  assert.equal(await once.gate.gate("mcp__private", {}), undefined);
  assert.match(once.asked[0]?.reason ?? "", /does not declare which paths/);

  const allowed = harness([{ kind: "allow", grant: { path: cwd, access: "ro", glob: cwd, exact: true } }]);
  const result = await allowed.gate.gate("mcp__private", {});
  assert.equal(result?.block, true, "a folder grant cannot cover unknown paths");
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

test("parseRule accepts tool/resource/effect and falls back to the claim's resource", () => {
  assert.deepEqual(parseRule("bash rm * deny", "/x"), { action: "bash", resource: "rm *", effect: "deny" });
  assert.deepEqual(parseRule("/other/* allow", "/x"), { action: "*", resource: "/other/*", effect: "allow" });
  assert.deepEqual(parseRule("ask", "/x"), { action: "*", resource: "/x", effect: "ask" });
  assert.throws(() => parseRule("nonsense", "/x"), /Cannot read rule/);
});
