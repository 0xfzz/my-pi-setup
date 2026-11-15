import test from "node:test";
import assert from "node:assert/strict";
import { validateView } from "../web/core/plugin-contracts/view.ts";
import {
  MAX_ACTION_VALUES,
  validateActionValues,
} from "../web/core/plugin-contracts/actions.ts";

/**
 * A dialog form is the generic multi-answer surface: an extension publishes
 * the fields of one step and receives the submitted values back through the
 * action pipeline, so a wizard's state lives in the extension rather than in
 * the host. Both ends are untrusted input from the browser, so both are
 * validated here.
 */

test("a dialog form carries typed, masked and menu fields", () => {
  const result = validateView({
    type: "dialog",
    title: "Add provider",
    fields: [
      { name: "id", label: "Provider ID", required: true },
      { name: "apiKey", label: "API key", kind: "secret", placeholder: "$ACME_API_KEY" },
      { name: "api", label: "API protocol", kind: "select", choices: ["openai-completions", "anthropic-messages"] },
    ],
    actions: [{ id: "continue", label: "Continue", tone: "primary", submitsInput: true }],
  });
  assert.equal(result.ok, true);
  if (!result.ok || result.view.type !== "dialog") return;
  assert.deepEqual(result.view.fields, [
    { name: "id", label: "Provider ID", required: true },
    { name: "apiKey", label: "API key", kind: "secret", placeholder: "$ACME_API_KEY" },
    {
      name: "api",
      label: "API protocol",
      kind: "select",
      choices: ["openai-completions", "anthropic-messages"],
    },
  ]);
});

test("a form is enough on its own, without a body or lines", () => {
  const result = validateView({
    type: "dialog",
    fields: [{ name: "id", label: "Provider ID" }],
  });
  assert.equal(result.ok, true);
});

test("a dialog declares input or fields, never both", () => {
  const result = validateView({
    type: "dialog",
    input: { placeholder: "type" },
    fields: [{ name: "id", label: "Provider ID" }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /input or fields/);
});

test("a secret field may not carry a value", () => {
  // A pre-filled credential would be re-published on every render, so it
  // would live in the event stream and in the browser.
  const result = validateView({
    type: "dialog",
    fields: [{ name: "apiKey", label: "API key", kind: "secret", value: "sk-live" }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /secret field cannot carry a value/);
});

test("a select without choices is a dead end", () => {
  const result = validateView({
    type: "dialog",
    fields: [{ name: "api", label: "API", kind: "select" }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /needs choices/);
});

test("field names, duplicates, kinds and the cap are enforced", () => {
  const badName = validateView({ type: "dialog", fields: [{ name: "Provider Id", label: "x" }] });
  assert.equal(badName.ok, false);

  const duplicate = validateView({
    type: "dialog",
    fields: [{ name: "id", label: "a" }, { name: "id", label: "b" }],
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.match(duplicate.error, /declared twice/);

  const badKind = validateView({
    type: "dialog",
    fields: [{ name: "id", label: "a", kind: "checkbox" }],
  });
  assert.equal(badKind.ok, false);

  const tooMany = validateView({
    type: "dialog",
    fields: Array.from({ length: 13 }, (_, index) => ({ name: `f${index}`, label: `f${index}` })),
  });
  assert.equal(tooMany.ok, false);
});

test("a submitted form is bounded and keyed by plain field names", () => {
  assert.deepEqual(validateActionValues({ id: "acme", baseUrl: "https://x/v1" }), {
    ok: true,
    values: { id: "acme", baseUrl: "https://x/v1" },
  });
  assert.deepEqual(validateActionValues(undefined), { ok: true });

  assert.equal(validateActionValues(["a"]).ok, false);
  assert.equal(validateActionValues({ __proto__x: "a" }).ok, false);
  assert.equal(validateActionValues({ id: 42 }).ok, false);
  assert.equal(validateActionValues({ id: "x".repeat(4001) }).ok, false);

  const tooMany = Object.fromEntries(
    Array.from({ length: MAX_ACTION_VALUES + 1 }, (_, index) => [`f${index}`, "x"]),
  );
  assert.equal(validateActionValues(tooMany).ok, false);
});
