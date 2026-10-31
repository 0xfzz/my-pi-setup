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
  defaults: { external: "ask", readExternal: "allow" },
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
  assert.deepEqual(parseScopeCommand("remove ../shared"), { kind: "remove", path: "../shared", target: "session" });
  assert.deepEqual(parseScopeCommand("remove ../shared --project"), { kind: "remove", path: "../shared", target: "project" });
  assert.equal(parseScopeCommand("remove").kind, "usage");
  assert.deepEqual(parseScopeCommand("test ../shared/a.ts"), { kind: "test", path: "../shared/a.ts" });
  assert.deepEqual(parseScopeCommand("reset"), { kind: "reset" });
  assert.deepEqual(parseScopeCommand("rules"), { kind: "rules" });
  assert.deepEqual(parseScopeCommand("log 5"), { kind: "log", limit: 5 });
  assert.deepEqual(parseScopeCommand("log"), { kind: "log", limit: 20 });
});

test("a rule is revocable by the name it is listed under", () => {
  assert.deepEqual(
    parseScopeCommand("remove --rule bash rm *"),
    { kind: "remove-rule", action: "bash", resource: "rm *", target: "session" },
  );
  assert.deepEqual(
    parseScopeCommand("remove --rule * /secrets/* --global"),
    { kind: "remove-rule", action: "*", resource: "/secrets/*", target: "global" },
  );
  // A row pasted straight from /scope rules keeps its trailing effect.
  assert.deepEqual(
    parseScopeCommand("remove --rule * /secrets/* deny"),
    { kind: "remove-rule", action: "*", resource: "/secrets/*", target: "session" },
  );
  assert.equal(parseScopeCommand("remove --rule bash").kind, "usage", "an action without a glob is not a rule");
});

test("yolo parses its modes and persistence flag", () => {
  assert.deepEqual(parseScopeCommand("yolo"), { kind: "yolo", mode: "on", persist: false });
  assert.deepEqual(parseScopeCommand("yolo all"), { kind: "yolo", mode: "all", persist: false });
  assert.deepEqual(parseScopeCommand("yolo off"), { kind: "yolo", mode: "off", persist: false });
  assert.deepEqual(parseScopeCommand("yolo status"), { kind: "yolo", mode: "status", persist: false });
  assert.deepEqual(parseScopeCommand("yolo on --persist"), { kind: "yolo", mode: "on", persist: true });
  assert.equal(parseScopeCommand("yolo maybe").kind, "usage");
});

test("sandbox subcommands parse correctly", () => {
  assert.deepEqual(parseScopeCommand("sandbox"), { kind: "sandbox", action: { kind: "status" } });
  assert.deepEqual(parseScopeCommand("sandbox status"), { kind: "sandbox", action: { kind: "status" } });
  assert.deepEqual(parseScopeCommand("sandbox on"), { kind: "sandbox", action: { kind: "on" } });
  assert.deepEqual(parseScopeCommand("sandbox off"), { kind: "sandbox", action: { kind: "off" } });
  assert.deepEqual(parseScopeCommand("sandbox probe"), { kind: "sandbox", action: { kind: "probe" } });
  assert.deepEqual(parseScopeCommand("sandbox mode workspace"), { kind: "sandbox", action: { kind: "mode", mode: "workspace" } });
  assert.deepEqual(parseScopeCommand("sandbox mode readonly"), { kind: "sandbox", action: { kind: "mode", mode: "readonly" } });
  assert.equal(parseScopeCommand("sandbox mode invalid").kind, "usage");
  assert.deepEqual(parseScopeCommand("sandbox backend bwrap"), { kind: "sandbox", action: { kind: "backend", backend: "bwrap" } });
  assert.equal(parseScopeCommand("sandbox backend unknown").kind, "usage");
  assert.deepEqual(parseScopeCommand("sandbox ask both"), { kind: "sandbox", action: { kind: "ask", ask: "both" } });
  assert.equal(parseScopeCommand("sandbox ask invalid").kind, "usage");
  assert.deepEqual(parseScopeCommand("sandbox retry auto"), { kind: "sandbox", action: { kind: "retry", retry: "auto" } });
  assert.equal(parseScopeCommand("sandbox retry invalid").kind, "usage");
  assert.deepEqual(parseScopeCommand("sandbox allow /var/run/docker.sock"), { kind: "sandbox", action: { kind: "allow", path: "/var/run/docker.sock" } });
  assert.equal(parseScopeCommand("sandbox allow").kind, "usage");
  assert.deepEqual(parseScopeCommand("sandbox deny /srv/secret"), { kind: "sandbox", action: { kind: "deny", path: "/srv/secret" } });
  assert.equal(parseScopeCommand("sandbox deny").kind, "usage");
  assert.deepEqual(parseScopeCommand("sandbox test ls -la"), { kind: "sandbox", action: { kind: "test", command: "ls -la" } });
  assert.equal(parseScopeCommand("sandbox test").kind, "usage");
  assert.equal(parseScopeCommand("sandbox unknownSub").kind, "usage");
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
  assert.deepEqual(
    scopeCompletions("sandbox ").map(item => item.value),
    [
      "sandbox status", "sandbox on", "sandbox off", "sandbox mode", "sandbox backend",
      "sandbox ask", "sandbox retry", "sandbox probe", "sandbox allow", "sandbox deny", "sandbox test",
    ],
  );
  assert.deepEqual(scopeCompletions("sandbox mode ").map(item => item.value), ["sandbox mode workspace", "sandbox mode readonly", "sandbox mode off"]);
  assert.deepEqual(scopeCompletions("sandbox backend ").map(item => item.value), ["sandbox backend auto", "sandbox backend landlock", "sandbox backend bwrap", "sandbox backend seatbelt", "sandbox backend none"]);
});

test("status lists every root with its access and provenance, plus both defaults", () => {
  const lines = statusLines(state, "/work", ["/work/.pi/scope.json"]);
  const text = lines.join("\n");
  assert.match(text, /workspace {2}rw {2}\(session\)/);
  assert.match(text, /vendor {2}ro {2}\(project\)/);
  assert.match(text, /\/shared {2}ro {2}\(session\)/);
  assert.match(text, /write-outside=ask read-outside=allow/);
  assert.doesNotMatch(text, /unknown=/, "there is no unknown default left to report");
  assert.match(text, /rules: 1/);
  assert.match(text, /\/work\/\.pi\/scope\.json/);
});

test("status names yolo and how to disarm it", () => {
  const armed = statusLines({ ...state, yolo: { strength: "ro", persist: false, since: 0 } }, "/work", []);
  assert.match(armed.join("\n"), /yolo: ro/);
  assert.match(armed.join("\n"), /\/scope yolo off/);

  const withSandbox = statusLines(
    {
      ...state,
      sandbox: {
        mode: "workspace",
        backend: "bwrap",
        ask: "both",
        retry: "model",
        scratch: "session",
        allow: ["/allow/1"],
        deny: [],
      },
    },
    "/work",
    [],
  );
  assert.match(withSandbox.join("\n"), /sandbox: workspace · backend=bwrap · ask=both · allow=1/);
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
