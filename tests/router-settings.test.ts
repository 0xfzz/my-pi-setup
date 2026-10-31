import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyFailure, cycleMethod, cycleValue, cycleWhen, describeChain, describeModelFacts, describeTarget,
  fileChoiceOf, formatTokens, mergeTargets, moveTarget, replaceTarget, routeIssues, routeNameProblem,
  routerModelChoices, routerRows, suggestRouteName, whenOf, withPolicy,
} from "../lib/router-settings.ts";
import type { SourcedRoute } from "../lib/router-config.ts";

const sourced = (name: string, targets: string[], extra: Partial<SourcedRoute["route"]> = {}): SourcedRoute => ({
  route: { name, targets: targets.map((model) => ({ model })), ...extra },
  source: "project",
});

// ── Row rendering ────────────────────────────────────────────────────────────

test("a target shows its pool and thinking level, and the chain joins them in order", () => {
  assert.equal(describeTarget({ model: "a/one" }), "a/one");
  assert.equal(describeTarget({ model: "a/one", pool: "ag", thinking: "high" }), "a/one [ag]:high");
  assert.equal(
    describeChain({ name: "r", targets: [{ model: "a/one" }, { model: "b/two", pool: "or" }] }),
    "a/one → b/two [or]",
  );
});

test("rows carry the virtual id, the policy and the source file", () => {
  const rows = routerRows(
    [
      { ...sourced("auto", ["a/one", "b/two"]), source: "global" },
      { ...sourced("cheap", ["a/one"], { method: "cheapest", when: "quota" }), source: "project" },
    ],
    "router",
    [],
  );
  assert.deepEqual(rows.map((row) => row.id), ["router/auto", "router/cheap"]);
  assert.equal(rows[0]!.policy, "priority · every turn");
  assert.equal(rows[1]!.policy, "cheapest · on quota");
  assert.equal(rows[0]!.source, "global");
  assert.equal(rows[0]!.chain, "a/one → b/two");
});

test("row issues name an unknown pool and a duplicated target instead of hiding them", () => {
  const issues = routeIssues({ name: "r", pool: "ghost", targets: [{ model: "a/one", pool: "ghost" }, { model: "a/one" }] }, ["ag"]);
  assert.ok(issues.some((issue) => /route pool "ghost" is not configured/.test(issue)));
  assert.ok(issues.some((issue) => /target a\/one names unknown pool "ghost"/.test(issue)));
  assert.ok(issues.some((issue) => /a\/one is listed twice/.test(issue)));
  assert.deepEqual(routeIssues({ name: "ok", targets: [{ model: "a/one", pool: "ag" }] }, ["ag"]), []);
});

test("a global route maps to the global file, everything else to the project file", () => {
  assert.equal(fileChoiceOf("global"), "global");
  assert.equal(fileChoiceOf("project"), "project");
});

// ── Editing helpers ──────────────────────────────────────────────────────────

test("merging picked models appends only new ones and keeps existing target settings", () => {
  const existing = [{ model: "a/one", pool: "ag", thinking: "high" }, { model: "b/two" }];
  const merged = mergeTargets(existing, ["b/two", "c/three", "a/one"]);
  assert.deepEqual(merged, [
    { model: "a/one", pool: "ag", thinking: "high" },
    { model: "b/two" },
    { model: "c/three" },
  ]);
  assert.deepEqual(existing, [{ model: "a/one", pool: "ag", thinking: "high" }, { model: "b/two" }], "the input is not mutated");
});

test("moving a target clamps at both ends instead of wrapping", () => {
  const targets = [{ model: "a/1" }, { model: "a/2" }, { model: "a/3" }];
  assert.deepEqual(moveTarget(targets, 0, 1).map((t) => t.model), ["a/2", "a/1", "a/3"]);
  assert.deepEqual(moveTarget(targets, 2, 1).map((t) => t.model), ["a/1", "a/2", "a/3"]);
  assert.deepEqual(moveTarget(targets, 0, -1).map((t) => t.model), ["a/1", "a/2", "a/3"]);
  assert.deepEqual(moveTarget(targets, 9, 1).map((t) => t.model), ["a/1", "a/2", "a/3"]);
});

test("replacing a target with undefined removes exactly that entry", () => {
  const targets = [{ model: "a/1" }, { model: "a/2" }, { model: "a/3" }];
  assert.deepEqual(replaceTarget(targets, 1, undefined).map((t) => t.model), ["a/1", "a/3"]);
  assert.deepEqual(replaceTarget(targets, 1, { model: "a/2", thinking: "low" })[1], { model: "a/2", thinking: "low" });
});

test("cycles walk their whole vocabulary and wrap", () => {
  assert.equal(cycleValue(["a", "b", "c"], "c"), "a");
  assert.equal(cycleMethod("priority"), "round-robin");
  assert.equal(cycleMethod("last-good"), "priority");
  assert.equal(cycleWhen("overflow"), "turn");
});

test("a saved route drops the fields that only restate the defaults", () => {
  const saved = withPolicy({ name: "r", targets: [] }, "priority", "turn");
  assert.equal(saved.method, undefined);
  assert.equal(saved.when, undefined);
  const explicit = withPolicy({ name: "r", targets: [] }, "cheapest", "quota");
  assert.equal(explicit.method, "cheapest");
  assert.equal(explicit.when, "quota");
  assert.equal(whenOf({ name: "r", targets: [] }), "turn", "an absent when still reads as the default");
});

// ── Name validation ──────────────────────────────────────────────────────────

test("a route name is validated against the same rule the parser applies", () => {
  assert.equal(routeNameProblem("auto", []), undefined);
  assert.match(routeNameProblem("", [])!, /needs a name/);
  assert.match(routeNameProblem("bad name", [])!, /letters, digits, dot, dash or underscore/);
  assert.match(routeNameProblem("-leading", [])!, /start with a letter or digit/);
  assert.match(routeNameProblem("auto", ["auto"])!, /already exists/);
  assert.match(routeNameProblem("status", [])!, /reads like a \/router subcommand/);
});

test("a suggested name is always free", () => {
  assert.equal(suggestRouteName([]), "route-1");
  assert.equal(suggestRouteName(["route-1", "route-2"]), "route-3");
});

// ── Model catalog for the picker ─────────────────────────────────────────────

test("the picker offers physical chat models and excludes the router and pool shadows", () => {
  const choices = routerModelChoices([
    { provider: "antigravity", id: "gemini-3-pro", name: "Gemini 3 Pro" },
    { provider: "openai", id: "gpt-6" },
    { provider: "router", id: "auto", api: "pi-virtual" },
    { provider: "router", id: "cheap", api: "pi-virtual" },
    { provider: "pool:ag", id: "gemini-3-pro" },
    { provider: "openai", id: "gpt-6", name: "duplicate" },
    { provider: "antigravity", id: "image-1", type: "image" },
    { provider: "", id: "broken" },
  ], { excludeProviders: ["router"] });
  assert.deepEqual(choices.map((choice) => choice.id), ["antigravity/gemini-3-pro", "openai/gpt-6"]);
  assert.equal(choices[0]!.name, "Gemini 3 Pro");
});

test("a classifier or embedding entry never becomes a route target", () => {
  const choices = routerModelChoices([
    { provider: "p", id: "chat", type: "chat" },
    { provider: "p", id: "classifier", type: "classifier" },
  ]);
  assert.deepEqual(choices.map((choice) => choice.id), ["p/chat"]);
});

// ── Failure classification ───────────────────────────────────────────────────

test("a failure is classified for the quota and overflow triggers", () => {
  assert.equal(classifyFailure("429 Too Many Requests"), "quota");
  assert.equal(classifyFailure("Quota reached. Please wait 54h10m43s."), "quota");
  assert.equal(classifyFailure("resource_exhausted: rate limit"), "quota");
  assert.equal(classifyFailure("This model's maximum context length is 200000 tokens"), "overflow");
  assert.equal(classifyFailure("prompt is too long"), "overflow");
  assert.equal(classifyFailure("401 invalid token"), "other");
  assert.equal(classifyFailure("stream ended without a result"), "other");
  assert.equal(classifyFailure(undefined), "other");
});

test("the picker shows the same facts /models does, in the same order", () => {
  assert.equal(describeModelFacts({
    provider: "p", id: "m", contextWindow: 200_000, maxTokens: 8_192, reasoning: true, input: ["text", "image"],
  }), "200K ctx · 8.2K out · thinking · images");
  assert.equal(describeModelFacts({ provider: "p", id: "m", contextWindow: 1_000_000 }), "1M ctx");
  assert.equal(describeModelFacts({ provider: "p", id: "m", maxTokens: 1_500 }), "1.5K out");
  assert.equal(describeModelFacts({ provider: "p", id: "m", input: ["text"] }), "",
    "text-only and non-thinking models add nothing rather than noise");
  assert.equal(describeModelFacts({ provider: "p", id: "m" }), "");
});

test("token counts are abbreviated exactly like the model list", () => {
  assert.equal(formatTokens(8192), "8.2K", "the same rounding /models uses");
  assert.equal(formatTokens(8000), "8K");
  assert.equal(formatTokens(200_000), "200K");
  assert.equal(formatTokens(1_000_000), "1M");
  assert.equal(formatTokens(1_500_000), "1.5M");
  assert.equal(formatTokens(512), "512");
});

test("each choice carries its facts so the picker can show them", () => {
  const [choice] = routerModelChoices([
    { provider: "openai", id: "gpt-6", name: "GPT-6", contextWindow: 200_000, maxTokens: 8_192, reasoning: true },
  ]);
  assert.deepEqual(choice, { id: "openai/gpt-6", name: "GPT-6", detail: "200K ctx · 8.2K out · thinking" });
  const [bare] = routerModelChoices([{ provider: "p", id: "m" }]);
  assert.deepEqual(bare, { id: "p/m", name: "m" }, "a model with no metadata gains no empty detail");
});
