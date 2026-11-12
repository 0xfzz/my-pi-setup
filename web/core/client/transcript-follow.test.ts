// Follow policy: the transcript moves only for a reader at the end, an
// explicit jump, or a prompt they sent. Each test names the failure it guards.

import test from "node:test";
import assert from "node:assert/strict";
import { FOLLOW_THRESHOLD_PX, INITIAL_FOLLOW, isNearEnd, reduceFollow, type FollowState } from "./transcript-follow.ts";

const atEnd = { scrollTop: 900, scrollHeight: 1400, clientHeight: 480 };
const awayFromEnd = { scrollTop: 300, scrollHeight: 1400, clientHeight: 480 };
const scrolled = (metrics: typeof atEnd): { kind: "scrolled"; metrics: typeof atEnd } => ({ kind: "scrolled", metrics });

test("a reader scrolled away from the end is not moved by new content", () => {
  const away = reduceFollow(INITIAL_FOLLOW, scrolled(awayFromEnd));
  const next = reduceFollow(away, { kind: "grew" });
  assert.equal(next.pinned, false, "growth must not re-pin a reader who scrolled up");
  assert.equal(next.unread, true, "growth while away is marked unread");
});

test("a reader who stays away is not pulled back by any number of stream ticks", () => {
  let state: FollowState = reduceFollow(INITIAL_FOLLOW, scrolled(awayFromEnd));
  for (let tick = 0; tick < 500; tick += 1) state = reduceFollow(state, { kind: "grew" });
  assert.equal(state.pinned, false, "no idle timer re-pins a reader who scrolled away");
});

test("a pinned reader stays pinned through new content", () => {
  const next = reduceFollow(INITIAL_FOLLOW, { kind: "grew" });
  assert.deepEqual(next, { pinned: true, unread: false });
});

test("scrolling back to the end re-pins and clears the unread marker", () => {
  const unread: FollowState = { pinned: false, unread: true };
  const next = reduceFollow(unread, scrolled(atEnd));
  assert.deepEqual(next, { pinned: true, unread: false });
});

test("the jump button and a prompt both pin the view to the end", () => {
  const away: FollowState = { pinned: false, unread: true };
  assert.deepEqual(reduceFollow(away, { kind: "jumped" }), { pinned: true, unread: false });
});

test("the end threshold is exclusive at FOLLOW_THRESHOLD_PX", () => {
  const justInside = { scrollTop: 1400 - 480 - (FOLLOW_THRESHOLD_PX - 1), scrollHeight: 1400, clientHeight: 480 };
  const atThreshold = { scrollTop: 1400 - 480 - FOLLOW_THRESHOLD_PX, scrollHeight: 1400, clientHeight: 480 };
  assert.equal(isNearEnd(justInside), true, "one pixel inside the threshold counts as the end");
  assert.equal(isNearEnd(atThreshold), false, "exactly the threshold is no longer the end");
});

test("an empty transcript with no overflow counts as the end", () => {
  assert.equal(isNearEnd({ scrollTop: 0, scrollHeight: 120, clientHeight: 480 }), true);
});
