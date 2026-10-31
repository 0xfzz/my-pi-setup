import assert from "node:assert/strict";
import { test } from "node:test";
import { canKeepGrant, canKeepRule, sectionOf, settingsRows, yoloLabel } from "../lib/scope/settings.ts";
import type { ScopeRoot, ScopeRule, ScopeState } from "../lib/scope/types.ts";

const cwd = "/work";

const state = (overrides: Partial<ScopeState> = {}): ScopeState => ({
  roots: [{ path: cwd, access: "rw", source: "session" }],
  rules: [],
  defaults: { external: "ask", readExternal: "allow" },
  ...overrides,
});

test("the settings rows are the workspace, then rules, defaults and yolo in order", () => {
  const rules: ScopeRule[] = [{ action: "read", resource: "/secrets/*", effect: "deny", source: "project" }];
  const roots: ScopeRoot[] = [
    { path: cwd, access: "rw", source: "session" },
    { path: "/srv/data", access: "ro", source: "project" },
  ];
  const rows = settingsRows(state({ roots, rules }), cwd);
  assert.deepEqual(rows.map(sectionOf), ["Grants", "Grants", "Rules", "Defaults", "Defaults", "Yolo", "Sandbox"]);
  assert.deepEqual(rows.filter(row => row.kind === "grant").map(row => row.label), ["workspace", "/srv/data"]);
});

test("the sandbox row reports the armed mode and backend, or the parsing fallback", () => {
  const off = settingsRows(state(), cwd).find(row => row.kind === "sandbox");
  assert.equal(off?.kind === "sandbox" ? off.label : undefined, "off");
  assert.equal(off?.kind === "sandbox" ? off.badge : undefined, "bash writes outside the workspace rely on parsing");

  const armed = settingsRows(
    state({ sandbox: { mode: "workspace", backend: "landlock", ask: "refusal", retry: "model", scratch: "off", allow: [], deny: [] } }),
    cwd,
  ).find(row => row.kind === "sandbox");
  assert.equal(armed?.kind === "sandbox" ? armed.label : undefined, "workspace · landlock");
  assert.equal(armed?.kind === "sandbox" ? armed.badge : undefined, "kernel write-deny · ask: refusal");
});

test("the workspace row is marked built-in and cannot be removed or re-saved", () => {
  const [workspace] = settingsRows(state(), cwd);
  assert.equal(workspace?.kind, "grant");
  assert.equal(workspace?.kind === "grant" ? workspace.builtin : undefined, true);
  assert.equal(workspace?.kind === "grant" ? workspace.inConfig : undefined, false);
  assert.equal(workspace?.kind === "grant" ? workspace.badge : undefined, "read-write · session");
});

test("a config grant reports the file it lives in, a session grant does not", () => {
  const rows = settingsRows(
    state({
      roots: [
        { path: cwd, access: "rw", source: "session" },
        { path: "/srv/data", access: "ro", source: "project" },
        { path: "/opt/shared", access: "rw", source: "global" },
      ],
    }),
    cwd,
  );
  const grants = rows.filter(row => row.kind === "grant");
  assert.deepEqual(grants.map(row => row.inConfig), [false, true, true]);
  assert.deepEqual(grants.map(row => row.badge), ["read-write · session", "read-only · project", "read-write · global"]);
});

test("defaults and yolo rows carry the current value", () => {
  const rows = settingsRows(state({ defaults: { external: "deny", readExternal: "ask" }, yolo: { strength: "ro", persist: false, since: 1 } }), cwd);
  const defaults = rows.filter(row => row.kind === "default");
  assert.deepEqual(defaults.map(row => row.effect), ["deny", "ask"]);
  assert.deepEqual(defaults.map(row => row.label), ["write outside workspace", "read outside workspace"]);
  const yolo = rows.find(row => row.kind === "yolo");
  assert.equal(yolo?.kind === "yolo" ? yolo.strength : undefined, "ro");
  assert.equal(yolo?.kind === "yolo" ? yolo.label : undefined, "reads only");
});

test("only session/branch entries can be promoted to the workspace config", () => {
  assert.equal(canKeepGrant({ path: "/a", access: "ro", source: "session" }), true);
  assert.equal(canKeepGrant({ path: "/a", access: "ro", source: "branch" }), true);
  assert.equal(canKeepGrant({ path: "/a", access: "ro", source: "project" }), false);
  assert.equal(canKeepGrant({ path: "/a", access: "ro", source: "global" }), false);

  assert.equal(canKeepRule({ action: "read", resource: "*", effect: "deny" }), true);
  assert.equal(canKeepRule({ action: "read", resource: "*", effect: "deny", source: "branch" }), true);
  assert.equal(canKeepRule({ action: "read", resource: "*", effect: "deny", source: "project" }), false);
});

test("yolo is labelled in words, not flags", () => {
  assert.equal(yoloLabel(undefined), "off");
  assert.equal(yoloLabel("ro"), "reads only");
  assert.equal(yoloLabel("rw"), "reads and writes");
});
