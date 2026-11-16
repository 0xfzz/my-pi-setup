import test from "node:test";
import assert from "node:assert/strict";
import {
  compactionMarkerLabel,
  compactionStatusLabel,
  isCompactionReason,
} from "./compaction.ts";

test("compactionStatusLabel mirrors the terminal's wording per reason", () => {
  assert.equal(compactionStatusLabel("manual"), "Compacting context...");
  assert.equal(compactionStatusLabel("threshold"), "Auto-compacting...");
  assert.equal(compactionStatusLabel("overflow"), "Context overflow detected, auto-compacting...");
  // An unknown or missing reason still reads as a compaction, never blank.
  assert.equal(compactionStatusLabel(null), "Compacting context...");
});

test("isCompactionReason accepts only the three reasons pi emits", () => {
  for (const reason of ["manual", "threshold", "overflow"]) {
    assert.equal(isCompactionReason(reason), true, `${reason} is a reason`);
  }
  assert.equal(isCompactionReason("somethingElse"), false);
  assert.equal(isCompactionReason(undefined), false);
  assert.equal(isCompactionReason(3), false);
});

test("compactionMarkerLabel names the tokens a compaction replaced", () => {
  assert.equal(compactionMarkerLabel(128_000), "Compacted from 128k tokens");
  // The count renders through the context meter's own formatter, so the
  // marker and the meter never disagree about the same number.
  assert.equal(compactionMarkerLabel(12_500), "Compacted from 13k tokens");
  assert.equal(compactionMarkerLabel(8_400), "Compacted from 8.4k tokens");
  // No usable count: the marker still marks the boundary.
  assert.equal(compactionMarkerLabel(undefined), "Context compacted");
  assert.equal(compactionMarkerLabel(0), "Context compacted");
  assert.equal(compactionMarkerLabel(Number.NaN), "Context compacted");
});
