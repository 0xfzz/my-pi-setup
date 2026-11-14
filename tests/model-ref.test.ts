import test from "node:test";
import assert from "node:assert/strict";
import { findModelRef, uniqueModelRefs, type ModelRef } from "../lib/model-ref.ts";

/**
 * The web picker's pick arrives as `provider/id` strings and has to be
 * resolved back to a model. The pool it resolves against is the full list the
 * picker offered (scoped models first, then the whole catalogue), so a pick
 * from the "All models" tab resolves even when the session has a scope.
 */

const SCOPED: ModelRef = { provider: "anthropic", id: "claude-sonnet-4-6" };
const UNSCOPED: ModelRef = { provider: "openai", id: "gpt-6" };
const POOL: ModelRef[] = [SCOPED, UNSCOPED];

test("an exact provider/id resolves", () => {
  assert.deepEqual(findModelRef(POOL, "anthropic/claude-sonnet-4-6"), SCOPED);
});

test("a pick outside the session's scope resolves", () => {
  // The scope holds only SCOPED; the pool is what the picker showed, so the
  // unscoped pick is a legal choice (the TUI's selector allows it as well).
  assert.deepEqual(findModelRef(POOL, "openai/gpt-6"), UNSCOPED);
});

test("a bare id resolves when it is unique across providers", () => {
  assert.deepEqual(findModelRef(POOL, "gpt-6"), UNSCOPED);
});

test("a bare id shared by two providers is ambiguous", () => {
  const shared: ModelRef[] = [
    { provider: "openai", id: "same-id" },
    { provider: "openrouter", id: "same-id" },
  ];
  assert.equal(findModelRef(shared, "same-id"), undefined);
});

test("a scoped model repeated in the pool still resolves by bare id", () => {
  // The pool is built as scope + catalogue, which repeats every scoped model;
  // the duplicate must not read as an ambiguous bare id.
  const overlapping = uniqueModelRefs([SCOPED, SCOPED, UNSCOPED]);
  assert.deepEqual(findModelRef(overlapping, "claude-sonnet-4-6"), SCOPED);
});

test("surrounding whitespace is tolerated", () => {
  assert.deepEqual(findModelRef(POOL, "  openai/gpt-6  "), UNSCOPED);
});

test("an unknown term resolves to nothing", () => {
  assert.equal(findModelRef(POOL, "missing/model"), undefined);
  assert.equal(findModelRef([], "openai/gpt-6"), undefined);
});

test("uniqueModelRefs keeps the first occurrence, in order", () => {
  assert.deepEqual(uniqueModelRefs([SCOPED, UNSCOPED, SCOPED]), [SCOPED, UNSCOPED]);
});
