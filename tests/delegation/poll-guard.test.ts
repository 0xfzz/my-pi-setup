import test from "node:test";
import assert from "node:assert/strict";

import {
  noteInspection,
  POLL_GUARD_REASON,
  POLL_LIMIT,
  resetInspectionCounts,
} from "../../lib/delegation/poll-guard.ts";

test("the first inspections of the same command run; only the repeat is refused", () => {
  resetInspectionCounts();
  const command = "find src -type f | sort";
  for (let call = 1; call <= POLL_LIMIT; call++) {
    assert.equal(noteInspection("sess-a", command), false, `inspection ${call} is not a poll yet`);
  }
  assert.equal(noteInspection("sess-a", command), true, `inspection ${POLL_LIMIT + 1} is the same look again`);
  resetInspectionCounts();
});

test("whitespace differences are the same command; a different inspection always runs", () => {
  resetInspectionCounts();
  const command = "find src -type f";
  for (let call = 1; call <= POLL_LIMIT; call++) noteInspection("sess-a", command);
  assert.equal(noteInspection("sess-a", "  find   src   -type   f  "), true, "reformatting does not hide the repeat");
  assert.equal(noteInspection("sess-a", "find src/components -type f"), false, "a genuinely different look runs");
  resetInspectionCounts();
});

test("counts are per session, so one parent cannot refuse another", () => {
  resetInspectionCounts();
  const command = "ls src";
  for (let call = 1; call <= POLL_LIMIT; call++) noteInspection("sess-a", command);
  assert.equal(noteInspection("sess-b", command), false, "session b has not looked yet");
  assert.equal(noteInspection("sess-a", command), true);
  resetInspectionCounts();
});

test("the refusal names the lane and points at the real progress channel", () => {
  assert.match(POLL_GUARD_REASON, /already run/);
  assert.match(POLL_GUARD_REASON, /not a progress channel/);
  assert.match(POLL_GUARD_REASON, /agent_progress/);
  assert.match(POLL_GUARD_REASON, /End your turn/);
});
