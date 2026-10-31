import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeRoutePolicy, orderTargets, parseRouteTable, routeDecision, routeMethod, routeTargets, routeWhen,
  type RouteConfig, type RouteTarget, type TargetFacts,
} from "../lib/model-routes.ts";

const target = (model: string): RouteTarget => ({ model });

/** A route with no method/when: the shape every existing config file has. */
const route = (overrides: Partial<RouteConfig> = {}): RouteConfig => ({
  name: "auto",
  targets: [target("a/one"), target("a/two"), target("a/three")],
  ...overrides,
});

const ids = (targets: readonly RouteTarget[]) => targets.map((entry) => entry.model);

const factsFrom = (table: Record<string, number | undefined>) =>
  (entry: RouteTarget): TargetFacts | undefined => {
    const input = table[entry.model];
    return input === undefined ? undefined : { cost: { input, output: 0 } };
  };

// ── Schema: method and when ──────────────────────────────────────────────────

test("method and when are read from a route and validated against their own vocabulary", () => {
  const { table, errors } = parseRouteTable({
    routes: [
      { name: "auto", targets: ["a/x"], method: "cheapest", when: "quota" },
      { name: "plain", targets: ["a/x"] },
    ],
  });
  assert.deepEqual(errors, []);
  assert.equal(table.routes[0]!.method, "cheapest");
  assert.equal(table.routes[0]!.when, "quota");
  // An absent field stays absent: loading a config must not rewrite it.
  assert.equal(table.routes[1]!.method, undefined);
  assert.equal(table.routes[1]!.when, undefined);
});

test("an unknown method or when is an error that names the allowed values", () => {
  const { table, errors } = parseRouteTable({
    routes: [
      { name: "m", targets: ["a/x"], method: "fastest" },
      { name: "w", targets: ["a/x"], when: "sometimes" },
      { name: "t", targets: ["a/x"], method: 7 },
    ],
  });
  assert.deepEqual(table.routes, [], "a rejected route is not half-loaded");
  assert.equal(errors.length, 3);
  assert.match(errors[0]!, /route "m": unknown method "fastest"/);
  assert.match(errors[0]!, /priority, round-robin, cheapest, last-good/);
  assert.match(errors[1]!, /route "w": unknown when "sometimes"/);
  assert.match(errors[1]!, /turn, failure, quota, overflow/);
  assert.match(errors[2]!, /unknown method "7"/);
});

test("method and when default to the behaviour that existed before they were added", () => {
  const plain = route();
  assert.equal(routeMethod(plain), "priority");
  assert.equal(routeWhen(plain), "turn");
  assert.equal(describeRoutePolicy(plain), "priority · every turn");
  assert.equal(describeRoutePolicy(route({ method: "cheapest", when: "quota" })), "cheapest · on quota");
});

// ── Ordering methods ─────────────────────────────────────────────────────────

test("priority leaves declaration order untouched", () => {
  const ordered = orderTargets(route({ method: "priority" }), factsFrom({}), {
    cursor: "a/three", previous: "a/three",
  });
  assert.deepEqual(ids(ordered), ["a/one", "a/two", "a/three"]);
});

test("round-robin rotates past the cursor and wraps", () => {
  const rr = route({ method: "round-robin" });
  assert.deepEqual(ids(orderTargets(rr, factsFrom({}), { cursor: "a/one" })), ["a/two", "a/three", "a/one"]);
  assert.deepEqual(ids(orderTargets(rr, factsFrom({}), { cursor: "a/three" })), ["a/one", "a/two", "a/three"]);
  // No cursor yet, or a cursor that is no longer a target: start at the head.
  assert.deepEqual(ids(orderTargets(rr, factsFrom({}), {})), ["a/one", "a/two", "a/three"]);
  assert.deepEqual(ids(orderTargets(rr, factsFrom({}), { cursor: "gone/model" })), ["a/one", "a/two", "a/three"]);
});

test("cheapest sorts by price, keeps declaration order for ties and puts unknown prices last", () => {
  const cheap = route({ method: "cheapest" });
  const ordered = orderTargets(cheap, factsFrom({ "a/one": 9, "a/two": 1, "a/three": 3 }));
  assert.deepEqual(ids(ordered), ["a/two", "a/three", "a/one"]);

  // Equal prices keep the order the user wrote.
  const tied = orderTargets(cheap, factsFrom({ "a/one": 2, "a/two": 2 }));
  assert.deepEqual(ids(tied), ["a/one", "a/two", "a/three"], "the unpriced target stays last");

  // A model the catalog cannot price is never presented as the cheap option.
  const unpriced = orderTargets(
    route({ method: "cheapest", targets: [target("ghost/model"), target("a/two")] }),
    factsFrom({ "a/two": 5 }),
  );
  assert.deepEqual(ids(unpriced), ["a/two", "ghost/model"]);
});

test("last-good promotes the model that answered last and ignores an unknown one", () => {
  const lastGood = route({ method: "last-good" });
  assert.deepEqual(ids(orderTargets(lastGood, factsFrom({}), { previous: "a/three" })), ["a/three", "a/one", "a/two"]);
  assert.deepEqual(ids(orderTargets(lastGood, factsFrom({}), { previous: "a/one" })), ["a/one", "a/two", "a/three"]);
  assert.deepEqual(ids(orderTargets(lastGood, factsFrom({}), {})), ["a/one", "a/two", "a/three"]);
  assert.deepEqual(ids(orderTargets(lastGood, factsFrom({}), { previous: "gone/model" })), ["a/one", "a/two", "a/three"]);
});

test("ordering never changes the candidate set, only the head", () => {
  const base = route({ method: "cheapest" });
  const ordered = orderTargets(base, factsFrom({ "a/three": 1 }));
  assert.deepEqual(ids(ordered).sort(), ids(routeTargets(base)).sort());
  assert.equal(ordered.length, base.targets.length);
});

test("a single-target route is returned as-is by every method", () => {
  const single = { name: "s", targets: [target("a/one")] };
  for (const method of ["priority", "round-robin", "cheapest", "last-good"] as const) {
    assert.deepEqual(ids(orderTargets({ ...single, method }, factsFrom({}), { cursor: "a/one", previous: "a/one" })), ["a/one"]);
  }
});

// ── Triggers ─────────────────────────────────────────────────────────────────

test("turn re-decides each user request and keeps the answering model inside the loop", () => {
  const turn = route({ when: "turn" });
  assert.deepEqual(routeDecision(turn, { reason: "user" }), { head: "order", advance: false });
  assert.deepEqual(routeDecision(turn, { reason: "direct" }), { head: "order", advance: false });
  assert.deepEqual(routeDecision(turn, { reason: "continuation" }), { head: "previous", advance: false });
  assert.deepEqual(routeDecision(turn, { reason: "retry" }), { head: "order", advance: true });
});

test("failure keeps the answering model across user turns and only a retry moves on", () => {
  const failure = route({ when: "failure" });
  assert.deepEqual(routeDecision(failure, { reason: "user" }), { head: "previous", advance: false });
  assert.deepEqual(routeDecision(failure, { reason: "continuation" }), { head: "previous", advance: false });
  assert.deepEqual(routeDecision(failure, { reason: "retry" }), { head: "order", advance: true });
  // A compaction summary has no previous model to keep, so it uses the chain.
  assert.deepEqual(routeDecision(failure, { reason: "direct" }), { head: "order", advance: false });
});

test("quota only moves on when the retry follows a quota failure", () => {
  const quota = route({ when: "quota" });
  assert.deepEqual(routeDecision(quota, { reason: "user" }), { head: "previous", advance: false });
  assert.deepEqual(routeDecision(quota, { reason: "retry", failedClass: "quota" }), { head: "order", advance: true });
  // The whole point of this trigger: an unrelated failure retries the same target
  // instead of wandering to the next model.
  assert.deepEqual(routeDecision(quota, { reason: "retry", failedClass: "other" }), { head: "failed", advance: false });
  assert.deepEqual(routeDecision(quota, { reason: "retry", failedClass: "overflow" }), { head: "failed", advance: false });
  assert.deepEqual(routeDecision(quota, { reason: "retry" }), { head: "failed", advance: false });
});

test("overflow only moves on when the retry follows a context overflow", () => {
  const overflow = route({ when: "overflow" });
  assert.deepEqual(routeDecision(overflow, { reason: "user" }), { head: "previous", advance: false });
  assert.deepEqual(routeDecision(overflow, { reason: "retry", failedClass: "overflow" }), { head: "order", advance: true });
  assert.deepEqual(routeDecision(overflow, { reason: "retry", failedClass: "quota" }), { head: "failed", advance: false });
  assert.deepEqual(routeDecision(overflow, { reason: "retry", failedClass: "other" }), { head: "failed", advance: false });
});

test("every trigger keeps the answering model on a continuation request", () => {
  for (const when of ["turn", "failure", "quota", "overflow"] as const) {
    assert.deepEqual(routeDecision(route({ when }), { reason: "continuation" }), { head: "previous", advance: false }, when);
  }
});

test("only a trigger that matches advances the chain, so a non-matching retry keeps every target in place", () => {
  const quota = route({ when: "quota" });
  const decision = routeDecision(quota, { reason: "retry", failedClass: "other" });
  assert.equal(decision.advance, false);
  assert.equal(decision.head, "failed", "the retry names the failed target, so it is retried in place");
});
