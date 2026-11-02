import test from "node:test";
import assert from "node:assert/strict";

import {
  commandSegments,
  isWaitGuardTool,
  leadingCommand,
  waitCommandProblem,
  WAIT_GUARD_REASON,
} from "../../lib/delegation/wait-guard.ts";

test("a bare sleep is refused, because the parent is re-triggered instead", () => {
  const problem = waitCommandProblem("sleep 60");
  assert.ok(problem, "a parent that sleeps is polling a push channel");
  assert.match(problem!, /must not wait/);
  assert.match(problem!, /end your turn/);
  assert.ok(problem!.startsWith(WAIT_GUARD_REASON), "the refusal is one pinned sentence");
});

test("work that merely takes time is not a wait", () => {
  for (const command of [
    "npm test",
    "pnpm install",
    "cargo build --release",
    "git log --oneline -20",
    "docker compose up -d",
    "rg TODO src/",
    "read", // not a shell command at all
  ]) {
    assert.equal(waitCommandProblem(command), undefined, `${command} is work, not a wait`);
  }
});

test("wrapping a wait does not hide it", () => {
  const refused = [
    "env FOO=1 sleep 5",
    "sudo sleep 5",
    "timeout 60 sleep 30",
    "sleep 5 && npm test",
    "npm test; sleep 5",
    "npm test || sleep 5",
    "echo waiting | sleep 5",
    "bash -c 'sleep 5'", // the segment still starts with sleep inside the quote
    "/bin/sleep 5",
    "./scripts/sleep 5",
  ];
  for (const command of refused) {
    assert.ok(waitCommandProblem(command), `${command} hides a wait behind a wrapper`);
  }
});

test("unbounded loops and followers are refused", () => {
  assert.ok(waitCommandProblem("while true; do curl localhost; done"));
  assert.ok(waitCommandProblem("until false; do agent_running; done"));
  assert.ok(waitCommandProblem("tail -f logs/child.log"));
  assert.ok(waitCommandProblem("tail --follow=name out.log"));
  assert.ok(waitCommandProblem("watch -n 5 agent_running"));
  // A bounded read is not a follow.
  assert.equal(waitCommandProblem("tail -n 20 logs/child.log"), undefined);
});

test("ping is only a wait when it is unbounded", () => {
  assert.ok(waitCommandProblem("ping localhost"), "an unbounded ping never returns");
  assert.equal(waitCommandProblem("ping -c 3 localhost"), undefined);
  assert.equal(waitCommandProblem("ping --count=3 localhost"), undefined);
});

test("a non-shell or empty command is not judged", () => {
  assert.equal(waitCommandProblem(undefined), undefined);
  assert.equal(waitCommandProblem(""), undefined);
  assert.equal(waitCommandProblem("   "), undefined);
  assert.equal(waitCommandProblem(42), undefined, "an opaque argument is not guessed at");
});

test("segmentation and the leading word survive realistic shell shapes", () => {
  assert.deepEqual(commandSegments("a; b && c || d | e"), ["a", "b", "c", "d", "e"]);
  assert.equal(leadingCommand("FOO=1 BAR=2 npm test"), "npm");
  assert.equal(leadingCommand("timeout 60 npm test"), "npm");
  assert.equal(leadingCommand("/usr/bin/env node script.js"), "node");
  assert.equal(leadingCommand(""), "");
});

test("only bash is governed: the guard does not guess at gateway arguments", () => {
  assert.equal(isWaitGuardTool("bash"), true);
  assert.equal(isWaitGuardTool("read"), false);
  assert.equal(isWaitGuardTool("mcp"), false);
  assert.equal(isWaitGuardTool("browser"), false);
});

test("the refusal states its scope, so a service wait is not read as forbidden work", () => {
  assert.match(WAIT_GUARD_REASON, /must not wait on a child/);
  assert.match(WAIT_GUARD_REASON, /only while a child is in flight/);
  assert.match(WAIT_GUARD_REASON, /waiting for a service/);
});
