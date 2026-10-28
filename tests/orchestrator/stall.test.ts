/**
 * Stall detection must not fire on a child that is merely quiet.
 *
 * The old rule counted identical pane tails, so a child running this repository's
 * own suite — which prints nothing for over ninety seconds — was interrupted as
 * "stalled" while it was working. Session-file activity is the signal that was
 * missing: the transcript keeps growing even when the pane does not.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { nextStallStrikes } from "../../extensions/agent.ts";

const base = { previous: 0, unchanged: true, tailAvailable: true, sessionActive: false, cooling: false };

describe("stall strikes", () => {
  it("counts a truly quiet child", () => {
    assert.equal(nextStallStrikes(base), 1);
    assert.equal(nextStallStrikes({ ...base, previous: 2 }), 3);
  });

  it("resets while the session file is still being written", () => {
    // Identical pane tail, but the transcript grew: the child is working.
    assert.equal(nextStallStrikes({ ...base, previous: 2, sessionActive: true }), 0);
  });

  it("resets on a new pane tail, an unreadable tail, or a recent interrupt", () => {
    assert.equal(nextStallStrikes({ ...base, previous: 2, unchanged: false }), 0);
    assert.equal(nextStallStrikes({ ...base, previous: 2, tailAvailable: false }), 0);
    assert.equal(nextStallStrikes({ ...base, previous: 2, cooling: true }), 0);
  });

  it("never goes negative when a persisted count is corrupt", () => {
    assert.equal(nextStallStrikes({ ...base, previous: -5 }), 1);
  });
});
