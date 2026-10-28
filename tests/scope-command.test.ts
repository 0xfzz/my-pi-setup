import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decisionLine,
  parseScopeCommand,
  ruleLines,
  scopeCompletions,
  statusLines,
} from "../lib/scope/command.ts";
import { evaluateClaim } from "../lib/scope/policy.ts";
import type { ScopeState } from "../lib/scope/types.ts";

const state: ScopeState = {
  roots: [
    { path: "/work", access: "rw", source: "session" },
    { path: "/work/vendor", access: "ro", source: "project" },
    { path: "/shared", access: "ro", source: "session" },
  ],
  rules: [{ action: "bash", resource: "rm *", effect: "deny", source: "project" }],
  defaults: { external: "ask", readExternal: "allow", unknown: "ask" },
};

test("bare /scope and /scope status are the same thing", () => {
  assert.deepEqual(parseScopeCommand(""), { kind: "status" });
  assert.deepEqual(parseScopeCommand("status"), { kind: "status" });
});

test("allow parses access and target, and refuses contradictory flags", () => {
  assert.deepEqual(parseScopeCommand("allow ../shared"), { kind: "allow", path: "../shared", access: "rw", target: "session" });
  assert.deepEqual(parseScopeCommand("allow ../shared --ro"), { kind: "allow", path: "../shared", access: "ro", target: "session" });
  assert.deepEqual(parseScopeCommand("allow ../shared --ro --project"), { kind: "allow", path: "../shared", access: "ro", target: "project" });
  assert.deepEqual(parseScopeCommand("allow /srv --global"), { kind: "allow", path: "/srv", access: "rw", target: "global" });
  assert.equal(parseScopeCommand("allow x --ro --rw").kind, "usage");
  assert.equal(parseScopeCommand("allow").kind, "usage");
});

test("deny, remove, test, reset, rules and log parse", () => {
  assert.deepEqual(parseScopeCommand("deny secrets --project"), { kind: "deny", path: "secrets", target: "project" });
  assert.deepEqual(parseScopeCommand("remove ../shared"), { kind: "remove", path: "../shared" });
  assert.deepEqual(parseScopeCommand("test ../shared/a.ts"), { kind: "test", path: "../shared/a.ts" });
  assert.deepEqual(parseScopeCommand("reset"), { kind: "reset" });
  assert.deepEqual(parseScopeCommand("rules"), { kind: "rules" });
  assert.deepEqual(parseScopeCommand("log 5"), { kind: "log", limit: 5 });
  assert.deepEqual(parseScopeCommand("log"), { kind: "log", limit: 20 });
});

test("yolo parses its modes and persistence flag", () => {
  assert.deepEqual(parseScopeCommand("yolo"), { kind: "yolo", mode: "on", persist: false });
  assert.deepEqual(parseScopeCommand("yolo all"), { kind: "yolo", mode: "all", persist: false });
  assert.deepEqual(parseScopeCommand("yolo off"), { kind: "yolo", mode: "off", persist: false });
  assert.deepEqual(parseScopeCommand("yolo status"), { kind: "yolo", mode: "status", persist: false });
  assert.deepEqual(parseScopeCommand("yolo on --persist"), { kind: "yolo", mode: "on", persist: true });
  assert.equal(parseScopeCommand("yolo maybe").kind, "usage");
});

test("unknown input produces usage instead of a guessed action", () => {
  const action = parseScopeCommand("frobnicate");
  assert.equal(action.kind, "usage");
  assert.match(action.kind === "usage" ? action.detail : "", /Unknown subcommand/);
});

test("completions offer subcommands, then flags for the path commands", () => {
  assert.deepEqual(scopeCompletions("al").map(item => item.value), ["allow"]);
  assert.deepEqual(scopeCompletions("").map(item => item.value).slice(0, 3), ["status", "allow", "deny"]);
  assert.deepEqual(scopeCompletions("allow --").map(item => item.value), ["allow --ro", "allow --rw", "allow --project", "allow --global"]);
  assert.deepEqual(scopeCompletions("allow ../x"), [], "a typed path stops offering flags");
  assert.deepEqual(scopeCompletions("status "), []);
});

test("status lists every root with its access and provenance, plus both defaults", () => {
  const lines = statusLines(state, "/work", ["/work/.pi/scope.json"]);
  const text = lines.join("\n");
  assert.match(text, /workspace {2}rw {2}\(session\)/);
  assert.match(text, /vendor {2}ro {2}\(project\)/);
  assert.match(text, /\/shared {2}ro {2}\(session\)/);
  assert.match(text, /write-outside=ask read-outside=allow unknown=ask/);
  assert.match(text, /rules: 1/);
  assert.match(text, /\/work\/\.pi\/scope\.json/);
});

test("status names yolo and how to disarm it", () => {
  const armed = statusLines({ ...state, yolo: { strength: "ro", persist: false, since: 0 } }, "/work", []);
  assert.match(armed.join("\n"), /yolo: ro/);
  assert.match(armed.join("\n"), /\/scope yolo off/);
});

test("rules list shows effect and provenance, with an empty state", () => {
  assert.deepEqual(ruleLines({ ...state, rules: [] }), ["Scope rules: none"]);
  const lines = ruleLines(state).join("\n");
  assert.match(lines, /bash {2}rm \* {2}deny {2}\(project\)/);
});

test("a decision line names the rule or root that produced it", () => {
  const byRoot = evaluateClaim(
    { tool: "read", action: "read", absolute: "/work/a.ts", resource: "a.ts", write: false, posture: "read", external: false, kind: "file" },
    state,
  );
  assert.match(decisionLine(byRoot), /ALLOW/);
  assert.match(decisionLine(byRoot), /root \/work/);

  const byDefault = evaluateClaim(
    { tool: "read", action: "read", absolute: "/etc/x", resource: "/etc/x", write: false, posture: "read", external: true, kind: "file" },
    state,
  );
  assert.match(decisionLine(byDefault), /ALLOW/, "reads outside the workspace are open by default");
  const byWrite = evaluateClaim(
    { tool: "write", action: "write", absolute: "/etc/x", resource: "/etc/x", write: true, posture: "write", external: true, kind: "file" },
    state,
  );
  assert.match(decisionLine(byWrite), /ASK/, "an outside write still asks");
  assert.match(decisionLine(byDefault), /\[default\]/);
});
