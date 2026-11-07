import test from "node:test";
import assert from "node:assert/strict";

import {
  PLUGIN_EVENTS,
  PLUGIN_STATES,
  PluginLifecycle,
  TRANSITIONS,
  holdsResources,
  isLive,
  legalTransitions,
  transition,
  type PluginEvent,
  type PluginState,
} from "../lib/web-plugins/kernel/lifecycle.ts";

test("the happy path runs discovered to active and back to disposed", () => {
  const life = new PluginLifecycle("acme.zen");
  const path: PluginEvent[] = ["validate-ok", "resolve-ok", "enable", "load", "activate", "activated", "deactivate", "disposed"];
  for (const event of path) life.dispatch(event);
  assert.equal(life.state, "disposed");
  assert.deepEqual(life.history.map((h) => h.to), ["validated", "resolved", "enabled", "loaded", "activating", "active", "deactivating", "disposed"]);
});

test("every (state, event) pair is either a declared transition or rejected with a named error", () => {
  let legal = 0;
  for (const state of PLUGIN_STATES) {
    for (const event of PLUGIN_EVENTS) {
      const result = transition(state, event);
      const declared = Object.hasOwn(TRANSITIONS[state], event);
      assert.equal(result.ok, declared, `${state} + ${event}`);
      if (result.ok) legal++;
      else assert.match(result.error, new RegExp(`${event}.*${state}`));
    }
  }
  assert.equal(legal, legalTransitions().length);
});

test("every state is reachable from discovered and every non-terminal state has an exit", () => {
  const reached = new Set<PluginState>(["discovered"]);
  const queue: PluginState[] = ["discovered"];
  while (queue.length) {
    const from = queue.shift()!;
    for (const { to, from: source } of legalTransitions()) {
      if (source === from && !reached.has(to)) {
        reached.add(to);
        queue.push(to);
      }
    }
  }
  assert.deepEqual([...PLUGIN_STATES].filter((s) => !reached.has(s)), []);
  for (const terminal of ["rejected", "ignored"] as const) {
    assert.equal(legalTransitions().some((t) => t.from === terminal), false, `${terminal} has no exit`);
  }
});

test("active is the only live state, and only activating/active/deactivating hold resources", () => {
  for (const state of PLUGIN_STATES) {
    assert.equal(isLive(state), state === "active", state);
    assert.equal(holdsResources(state), state === "activating" || state === "active" || state === "deactivating", state);
  }
});

test("a rejected dispatch throws and leaves the state unchanged", () => {
  const life = new PluginLifecycle("acme.zen");
  assert.throws(() => life.dispatch("activate"), /illegal lifecycle event "activate" in state "discovered"/);
  assert.equal(life.state, "discovered");
  assert.equal(life.history.length, 0);
});

test("quarantine is reachable only from failed, disposed, or resolved (persisted quarantine), and clearing returns to enabled", () => {
  const sources = legalTransitions().filter((t) => t.event === "quarantine").map((t) => t.from).sort();
  assert.deepEqual(sources, ["disposed", "failed", "resolved"]);
  const life = new PluginLifecycle("acme.zen", { initial: "failed" });
  life.dispatch("quarantine");
  assert.equal(life.state, "quarantined");
  life.dispatch("clear-quarantine");
  assert.equal(life.state, "enabled");
});

test("a failed activation can retry or be disabled, never activated directly", () => {
  const life = new PluginLifecycle("acme.zen", { initial: "loaded" });
  life.dispatch("activate");
  life.dispatch("activate-fail");
  assert.equal(life.state, "failed");
  assert.equal(life.can("activated"), false);
  assert.equal(life.can("activate"), false);
  assert.equal(life.can("retry"), true);
  assert.equal(life.can("disable"), true);
});

test("history is bounded and records timestamps from the injected clock", () => {
  let now = 1000;
  const life = new PluginLifecycle("acme.zen", { clock: () => now, historyLimit: 3 });
  life.dispatch("validate-ok");
  life.dispatch("resolve-ok");
  life.dispatch("enable");
  now = 2000;
  life.dispatch("load");
  assert.equal(life.history.length, 3);
  assert.equal(life.history[2].at, 2000);
  assert.equal(life.history[0].event, "resolve-ok");
});
