import test from "node:test";
import assert from "node:assert/strict";

import { cleanTitle, stripDecoration, TITLE_MAX_CHARS } from "../lib/title/clean.ts";
import { titleRequestOptions, lengthRetryOptions, TITLE_MAX_TOKENS, TITLE_REASONING_MAX_TOKENS } from "../lib/title/model-options.ts";
import { decide, refineSignal, type PolicyState, AUTO_TITLE_CAP, MANUAL_COOLDOWN_MS } from "../lib/title/policy.ts";

test("a plain three-to-eight word line is the title, decoration stripped", () => {
  assert.deepEqual(cleanTitle("\"Fix the login redirect loop.\""), { kind: "title", title: "Fix the login redirect loop" });
  assert.deepEqual(cleanTitle("Title: **Refactor session cookies**\nmore text"), { kind: "title", title: "Refactor session cookies" });
  assert.deepEqual(cleanTitle("Judul: Perbaiki Login Redirect"), { kind: "title", title: "Perbaiki Login Redirect" });
});

test("each unusable output is a named rejection, never a title", () => {
  const cases: Array<[string, string]> = [
    ["", "empty"],
    ["   \n  ", "empty"],
    ["Login fix", "too-few-words"],
    ["one two three four five six seven eight nine", "too-many-words"],
    ["Coding help", "generic"],
    ["Refactor src/auth/session.ts", "path"],
    ["Check https://example.com/docs", "url"],
    ["3f2a9c1e-1111-4222-8333-444455556666", "identifier"],
    ["Fix the cache with abcdef0123456789abcdef", "identifier"],
  ];
  for (const [raw, reason] of cases) {
    assert.deepEqual(cleanTitle(raw), { kind: "rejected", reason }, `input ${JSON.stringify(raw)}`);
  }
});

test("an echo of the first user line is refused", () => {
  assert.deepEqual(
    cleanTitle("Fix login bug", { firstUser: "Fix login bug\nmore detail below" }),
    { kind: "rejected", reason: "echo" },
  );
  assert.deepEqual(
    cleanTitle("Fix the login bug", { firstUser: "Fix the login bug" }),
    { kind: "rejected", reason: "echo" },
  );
});

test("KEEP is valid only when a current title was supplied", () => {
  assert.deepEqual(cleanTitle("KEEP", { currentTitle: "Fix Login Bug" }), { kind: "keep" });
  assert.deepEqual(cleanTitle("KEEP"), { kind: "rejected", reason: "keep-without-current" });
});

test("titles are bounded to sixty characters on a word boundary", () => {
  const long = "Investigate the intermittent failure in the very long running nightly export pipeline job";
  const verdict = cleanTitle(long);
  assert.equal(verdict.kind, "title");
  assert.ok(verdict.kind === "title" && verdict.title.length <= TITLE_MAX_CHARS);
  assert.ok(verdict.kind === "title" && !verdict.title.endsWith(" "));
});

test("stripDecoration removes markup and trailing punctuation only", () => {
  assert.equal(stripDecoration("# **Plan the release.**"), "Plan the release");
  assert.equal(stripDecoration("“Quoted title”"), "Quoted title");
});

test("thinking off is the default; a model that cannot turn it off gets its lowest level and budget", () => {
  assert.deepEqual(titleRequestOptions({ reasoning: false }), { maxTokens: TITLE_MAX_TOKENS });
  assert.deepEqual(titleRequestOptions({ reasoning: true }), { maxTokens: TITLE_MAX_TOKENS });
  assert.deepEqual(
    titleRequestOptions({ reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low" } }),
    { reasoning: "low", maxTokens: TITLE_REASONING_MAX_TOKENS },
  );
  assert.deepEqual(
    titleRequestOptions({ reasoning: true, thinkingLevelMap: { off: null } }),
    { reasoning: "minimal", maxTokens: TITLE_REASONING_MAX_TOKENS },
  );
  assert.deepEqual(lengthRetryOptions({ maxTokens: 64 }), { maxTokens: 256 });
});

const base: PolicyState = {
  enabled: true,
  child: false,
  busy: false,
  name: "",
  generatedName: false,
  successes: 0,
  automaticAttempts: 0,
  hasExchange: true,
  refineSignal: false,
};

test("an untitled session with an exchange gets a provisional title", () => {
  assert.deepEqual(decide(base, "settled"), { action: "generate", kind: "provisional" });
});

test("a name a person chose locks the automatic path", () => {
  assert.deepEqual(decide({ ...base, name: "My name" }, "settled"), { action: "skip", reason: "named" });
});

test("a generated name is refined once, when a refinement signal holds", () => {
  const generated = { ...base, name: "Fix Login Bug", generatedName: true, successes: 1, automaticAttempts: 1 };
  assert.deepEqual(decide({ ...generated, refineSignal: true }, "settled"), { action: "generate", kind: "refine" });
  assert.deepEqual(decide({ ...generated, refineSignal: false }, "settled"), { action: "skip", reason: "not-refinable" });
  assert.deepEqual(decide({ ...generated, successes: 2, refineSignal: true }, "settled"), { action: "skip", reason: "not-refinable" });
});

test("the automatic cap counts failures, and stops at three", () => {
  assert.deepEqual(decide({ ...base, automaticAttempts: AUTO_TITLE_CAP - 1 }, "settled"), { action: "generate", kind: "provisional" });
  assert.deepEqual(decide({ ...base, automaticAttempts: AUTO_TITLE_CAP }, "settled"), { action: "skip", reason: "cap" });
});

test("a generated name the person cleared is not written again", () => {
  assert.deepEqual(decide({ ...base, successes: 1 }, "settled"), { action: "skip", reason: "cleared" });
});

test("disabled, child, busy and no-exchange each skip the automatic path with a reason", () => {
  assert.deepEqual(decide({ ...base, enabled: false }, "settled"), { action: "skip", reason: "disabled" });
  assert.deepEqual(decide({ ...base, child: true }, "settled"), { action: "skip", reason: "child" });
  assert.deepEqual(decide({ ...base, busy: true }, "settled"), { action: "skip", reason: "busy" });
  assert.deepEqual(decide({ ...base, hasExchange: false }, "settled"), { action: "skip", reason: "no-exchange" });
});

test("a manual regenerate ignores the cap and the lock, but not the cooldown or a request in flight", () => {
  const locked = { ...base, name: "My name", automaticAttempts: AUTO_TITLE_CAP };
  assert.deepEqual(decide(locked, "manual"), { action: "generate", kind: "manual" });
  assert.deepEqual(decide({ ...locked, sinceManualMs: MANUAL_COOLDOWN_MS - 1 }, "manual"), { action: "skip", reason: "cooldown" });
  assert.deepEqual(decide({ ...locked, busy: true }, "manual"), { action: "skip", reason: "busy" });
});

test("the refinement signal is a committed plan, or four user turns that touched files", () => {
  assert.equal(refineSignal({ hasPlan: true, userTurns: 1, footprint: "" }), true);
  assert.equal(refineSignal({ hasPlan: false, userTurns: 4, footprint: "edit×1" }), true);
  assert.equal(refineSignal({ hasPlan: false, userTurns: 4, footprint: "" }), false);
  assert.equal(refineSignal({ hasPlan: false, userTurns: 2, footprint: "edit×1" }), false);
});
