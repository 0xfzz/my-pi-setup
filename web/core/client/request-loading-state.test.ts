import assert from "node:assert/strict";
import test from "node:test";
import {
  REQUEST_LOADING_IDLE, REQUEST_LOADING_MIN_VISIBLE_MS, REQUEST_LOADING_REVEAL_MS, requestLoadingTick,
  type RequestLoadingAction, type RequestLoadingState,
} from "./request-loading-state.ts";

interface Step {
  state: RequestLoadingState;
  action: RequestLoadingAction;
  /** What the card does on screen after the tick: shown, held or still hidden. */
  visible: boolean;
}

/** Apply one tick the way the hook does: keep the state, then schedule the action. */
function step(state: RequestLoadingState, pending: number, now: number): Step {
  const next = requestLoadingTick(state, { pending, now });
  return {
    state: next.state,
    action: next.action,
    visible: next.action.kind === "show" || state.visibleSince !== null,
  };
}

test("a request that settles before the reveal delay never shows the card", () => {
  const started = step(REQUEST_LOADING_IDLE, 1, 0);
  assert.equal(started.action.kind, "show");
  assert.deepEqual(started.action, { kind: "show", delayMs: REQUEST_LOADING_REVEAL_MS });
  // The prompt's fetches finish long before that deadline: its timer is cleared
  // and the state returns to rest, so the card was never shown.
  const finished = step(started.state, 0, 40);
  assert.equal(finished.action.kind, "hold");
  assert.equal(finished.visible, false);
  assert.deepEqual(finished.state, REQUEST_LOADING_IDLE, "an idle tick forgets the finished stretch");
});

test("overlapping requests share one reveal deadline instead of restarting it", () => {
  const first = step(REQUEST_LOADING_IDLE, 1, 0);
  const second = step(first.state, 2, 100);
  assert.deepEqual(second.action, { kind: "show", delayMs: REQUEST_LOADING_REVEAL_MS - 100 },
    "the second request does not reset the clock");
  const revealed = step(second.state, 2, REQUEST_LOADING_REVEAL_MS);
  assert.deepEqual(revealed.action, { kind: "show", delayMs: 0 }, "a passed deadline reveals immediately");
});

test("work that outlives the reveal delay shows the card and holds it", () => {
  const shown = step({ pendingSince: 0, visibleSince: REQUEST_LOADING_REVEAL_MS }, 3, 400);
  assert.equal(shown.action.kind, "hold", "a visible card while work runs needs no further action");
  assert.equal(shown.visible, true);
});

test("a revealed card stays for the minimum visible time, then hides", () => {
  const visible = { pendingSince: 0, visibleSince: REQUEST_LOADING_REVEAL_MS };
  const early = step(visible, 0, REQUEST_LOADING_REVEAL_MS + 50);
  assert.deepEqual(early.action, { kind: "hide", delayMs: REQUEST_LOADING_MIN_VISIBLE_MS - 50 },
    "the hide is deferred, not immediate");
  assert.equal(early.visible, true, "it stays on screen during the deferral");
  const late = step(visible, 0, REQUEST_LOADING_REVEAL_MS + REQUEST_LOADING_MIN_VISIBLE_MS);
  assert.deepEqual(late.action, { kind: "hide", delayMs: 0 }, "past the minimum it hides at once");
});

test("work arriving during the minimum visible window keeps the card up", () => {
  const visible = { pendingSince: 0, visibleSince: REQUEST_LOADING_REVEAL_MS };
  const resumed = step(visible, 1, REQUEST_LOADING_REVEAL_MS + 50);
  assert.equal(resumed.action.kind, "hold");
  assert.equal(resumed.visible, true);
});

test("a tick that changes nothing keeps the same state object so a hook does not re-render", () => {
  assert.equal(requestLoadingTick(REQUEST_LOADING_IDLE, { pending: 0, now: 5 }).state, REQUEST_LOADING_IDLE);
  const visible = { pendingSince: 0, visibleSince: 1 };
  assert.equal(requestLoadingTick(visible, { pending: 1, now: 2 }).state, visible,
    "a visible card is not rebuilt while work runs");
});
