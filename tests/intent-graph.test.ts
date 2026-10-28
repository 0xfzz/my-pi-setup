import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlan, replay, refusal, applyTransition, checkEvidence, frontier, isReady, isBlocked,
  isExpiredClaim, isLiveClaim, injectionLine, fromLegacyState, taskIdFor, hashId,
  type Task, type Evidence,
} from "../lib/intent-graph.ts";

const now = 1_000_000;
const seed = (titles: string[], goal = "Fix the parser") =>
  buildPlan({ goal, scope: "committed", at: now, seeds: titles.map(title => ({ title })) });

const fileEvidence = (path = "src/a.ts"): Evidence => ({ kind: "file", path });

test("task ids are content-derived, so the same work converges across forks", () => {
  assert.equal(taskIdFor("goal", "Do the thing"), taskIdFor("goal", "  do   the THING "));
  assert.notEqual(taskIdFor("goal", "Do the thing"), taskIdFor("other goal", "Do the thing"));
  // Duplicate titles in one plan get a salted id instead of colliding.
  const second = taskIdFor("goal", "Same", [{ id: taskIdFor("goal", "Same") } as Task]);
  assert.match(second, /^t-[0-9a-f]{6}-2$/);
  assert.match(hashId("p", "x"), /^p-[0-9a-f]{6}$/);
});

test("dependencies may be written as titles and still form a graph", () => {
  const plan = buildPlan({
    goal: "g", scope: "committed", at: now,
    seeds: [{ title: "Write test" }, { title: "Implement", deps: ["write test"] }],
  });
  assert.equal(plan.tasks[1].deps[0], plan.tasks[0].id);
});

test("blocked is derived from dependencies, never declared", () => {
  const plan = buildPlan({
    goal: "g", scope: "committed", at: now,
    seeds: [{ title: "A" }, { title: "B", deps: ["A"] }],
  });
  const [a, b] = plan.tasks;
  assert.equal(isReady(plan, a, now), true);
  assert.equal(isBlocked(plan, b), true, "B waits on A");
  assert.deepEqual(frontier(plan, now).map(task => task.id), [a.id], "only A is claimable");

  const after = applyTransition(plan, { taskId: a.id, to: "done", by: "s", at: now, evidence: [fileEvidence()] }).plan;
  assert.equal(isBlocked(after, after.tasks[1]), false, "settling A unblocks B");
  assert.deepEqual(frontier(after, now).map(task => task.id), [b.id]);
});

test("a claim is a lease: expiry returns the task to the frontier", () => {
  const plan = seed(["Work"]);
  const { plan: claimed } = applyTransition(plan, { taskId: plan.tasks[0].id, to: "claimed", by: "agent-1", at: now, ttlMs: 1000 });
  assert.equal(isLiveClaim(claimed.tasks[0], now + 10), true);
  assert.equal(frontier(claimed, now + 10).length, 0, "a live claim hides the task");
  assert.equal(isExpiredClaim(claimed.tasks[0], now + 5000), true);
  assert.equal(isLiveClaim(claimed.tasks[0], now + 5000), false);
});

test("one live claim per resource; a second claimant is refused with the holder named", () => {
  const plan = buildPlan({
    goal: "g", scope: "committed", at: now,
    seeds: [{ title: "A", resource: "file:src/a.ts" }, { title: "B", resource: "file:src/a.ts" }],
  });
  const { plan: afterA } = applyTransition(plan, { taskId: plan.tasks[0].id, to: "claimed", by: "agent-1", at: now });
  const why = refusal(afterA, { taskId: afterA.tasks[1].id, to: "claimed", by: "agent-2", at: now });
  assert.match(String(why), /file:src\/a\.ts is claimed by agent-1/);
});

test("done requires evidence that is structurally real", () => {
  const plan = seed(["Work"]);
  const id = plan.tasks[0].id;
  assert.match(String(refusal(plan, { taskId: id, to: "done", by: "s", at: now })), /requires at least one evidence ref/);
  // An empty object is not evidence.
  assert.match(String(refusal(plan, { taskId: id, to: "done", by: "s", at: now, evidence: [{ kind: "file" } as Evidence] })), /requires at least one/);
  assert.equal(refusal(plan, { taskId: id, to: "done", by: "s", at: now, evidence: [fileEvidence()] }), undefined);
});

test("evidence is verified only when the harness can check it", () => {
  const exists = { fileExists: (path: string) => path === "src/real.ts" };
  assert.equal(checkEvidence({ kind: "file", path: "src/real.ts" }, exists).check, "verified");
  assert.equal(checkEvidence({ kind: "file", path: "src/missing.ts" }, exists).check, "attested");
  assert.equal(checkEvidence({ kind: "test", name: "x", pass: true }).check, "verified");
  // A command cannot be re-run here, so claiming "verified" for it would be dishonest.
  assert.equal(checkEvidence({ kind: "cmd", cmd: "npm test", exit: 0 }).check, "attested");

  const plan = seed(["Work"]);
  const verified = applyTransition(plan, { taskId: plan.tasks[0].id, to: "done", by: "s", at: now, evidence: [{ kind: "file", path: "src/real.ts" }] }, exists);
  assert.equal(verified.plan.tasks[0].verified, true);
  const attested = applyTransition(plan, { taskId: plan.tasks[0].id, to: "done", by: "s", at: now, evidence: [{ kind: "cmd", cmd: "npm test", exit: 0 }] }, exists);
  assert.equal(attested.plan.tasks[0].verified, false);
});

test("dropping needs no reason and never resurrects the task", () => {
  const plan = seed(["A", "B"]);
  const why = refusal(plan, { taskId: plan.tasks[0].id, to: "dropped", by: "s", at: now });
  assert.equal(why, undefined, "dropped must not demand an explanation");
  const { plan: after, entry } = applyTransition(plan, { taskId: plan.tasks[0].id, to: "dropped", by: "s", at: now });
  assert.equal(after.tasks[0].status, "dropped");

  // Re-declaring the plan does not bring a dropped task back to life.
  const rebuilt = buildPlan({ goal: "Fix the parser", scope: "committed", at: now, seeds: [{ title: "A" }, { title: "B" }], previous: after });
  assert.equal(rebuilt.tasks[0].status, "dropped");

  // The event survives even though the board shrank.
  const replayed = replay([{ v: 2, kind: "plan", plan }, entry]);
  assert.equal(replayed?.tasks[0].status, "dropped");
  assert.equal(replayed?.tasks.length, 2, "the log keeps the history the board drops");
});

test("settled work and settled evidence survive a re-declaration of the same goal", () => {
  const plan = seed(["A", "B"]);
  const { plan: after } = applyTransition(plan, { taskId: plan.tasks[0].id, to: "done", by: "s", at: now, evidence: [fileEvidence()] });
  const rebuilt = buildPlan({ goal: "Fix the parser", scope: "committed", at: now, seeds: [{ title: "A" }, { title: "B" }, { title: "C" }], previous: after });
  assert.equal(rebuilt.tasks[0].status, "done");
  assert.equal(rebuilt.tasks[0].evidence?.length, 1);
  assert.equal(rebuilt.tasks[2].status, "open", "new scope is added");
});

test("a different goal does not inherit a finished task, because ids are goal-scoped", () => {
  const plan = seed(["A"]);
  const { plan: after } = applyTransition(plan, { taskId: plan.tasks[0].id, to: "done", by: "s", at: now, evidence: [fileEvidence()] });
  const rebuilt = buildPlan({ goal: "Something else", scope: "committed", at: now, seeds: [{ title: "A" }], previous: after });
  assert.equal(rebuilt.tasks[0].status, "open");
});

test("a superseded plan stays readable but is never resumed", () => {
  const plan = seed(["A"]);
  const replayed = replay([
    { v: 2, kind: "plan", plan },
    { v: 2, kind: "supersede", planId: plan.id, at: now + 5, reason: "new goal" },
  ]);
  assert.equal(replayed?.supersededAt, now + 5);
  assert.equal(injectionLine(replayed, now + 10), undefined, "a retired plan injects nothing");
  assert.match(String(refusal(replayed!, { taskId: plan.tasks[0].id, to: "claimed", by: "s", at: now })), /superseded/);
});

test("injection is one line, committed-only, and silent once the plan is finished", () => {
  const committed = seed(["A", "B"]);
  const line = injectionLine(committed, now);
  assert.match(String(line), new RegExp(`^plan ${committed.id} · 0/2 done`));
  assert.match(String(line), /ready t-/);
  assert.equal(line!.includes("\n"), false, "never a blob");

  const scratch = buildPlan({ goal: "g", scope: "scratch", at: now, seeds: [{ title: "A" }] });
  assert.equal(injectionLine(scratch, now), undefined, "a scratch plan never enters context");

  let done = committed;
  for (const task of committed.tasks) {
    done = applyTransition(done, { taskId: task.id, to: "done", by: "s", at: now, evidence: [fileEvidence()] }).plan;
  }
  assert.equal(injectionLine(done, now), undefined, "a finished plan says nothing");
});

test("session isolation: another session's plan is not inherited", () => {
  const mine = seed(["Mine"]);
  const entries = [{ v: 2 as const, kind: "plan" as const, plan: mine, ownerSessionId: "other-session" }];
  // Replay itself is ownership-agnostic; the extension filters. Proves the datum exists.
  assert.equal(replay(entries)?.id, mine.id);
});

test("v1 state migrates honestly: prose evidence becomes a note, not verification", () => {
  const plan = fromLegacyState({
    version: 1,
    reason: "Old plan",
    items: [
      { id: 1, text: "Inspect", status: "in_progress" },
      { id: 2, text: "Fix", status: "done", note: "did it" },
      { id: 3, text: "Blocked thing", status: "blocked", note: "waiting on CI" },
      { id: 4, text: "Gone", status: "cancelled" },
    ],
  }, "sess", now)!;
  assert.equal(plan.tasks[0].status, "claimed");
  assert.equal(plan.tasks[1].status, "done");
  assert.equal(plan.tasks[1].verified, false, "a prose claim is never verified");
  assert.equal(plan.tasks[1].note, "did it");
  assert.equal(plan.tasks[2].status, "open", "a declared blocker becomes ordinary open work");
  assert.equal(plan.tasks[3].status, "dropped");
  assert.equal(plan.tasks.length, 4);
});

test("unknown task ids are refused with the ids that do exist", () => {
  const plan = seed(["A"]);
  const why = refusal(plan, { taskId: "t-nope", to: "claimed", by: "s", at: now });
  assert.match(String(why), new RegExp(`No task t-nope.*${plan.tasks[0].id}`));
});
