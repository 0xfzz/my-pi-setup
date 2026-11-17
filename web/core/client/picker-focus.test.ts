import assert from "node:assert/strict";
import test from "node:test";
import { shouldFocusPickerSearch } from "./picker-focus.ts";

test("picker search takes focus on pointer devices", () => {
  assert.equal(shouldFocusPickerSearch(false), true);
});

test("picker search leaves the keyboard closed on touch devices", () => {
  assert.equal(shouldFocusPickerSearch(true), false);
});
