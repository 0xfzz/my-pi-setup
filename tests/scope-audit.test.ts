import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAudit, ScopeLog } from "../lib/scope/audit.ts";

test("the log keeps the newest entries and drops the oldest", () => {
  const log = new ScopeLog(3);
  for (let index = 0; index < 5; index++) {
    log.add({ tool: `t${index}`, path: `/p/${index}`, write: false, outcome: "auto", at: index });
  }
  assert.deepEqual(log.list().map(entry => entry.tool), ["t2", "t3", "t4"]);
});

test("the log is append-only until cleared", () => {
  const log = new ScopeLog(10);
  log.add({ tool: "read", path: "/a", write: false, outcome: "ask", at: 0 });
  log.add({ tool: "read", path: "/a", write: false, outcome: "auto", at: 1 });
  assert.equal(log.list().length, 2);
  log.clear();
  assert.deepEqual(log.list(), []);
});

test("formatAudit shows the newest entries last and counts what it hides", () => {
  const log = new ScopeLog(50);
  for (let index = 0; index < 6; index++) {
    log.add({ tool: "read", path: `/p/${index}`, write: index % 2 === 0, outcome: "auto", at: 0 });
  }
  const lines = formatAudit(log.list(), 3);
  assert.match(lines[0]!, /3 older hidden/);
  assert.equal(lines.length, 4);
  assert.match(lines[1]!, /\/p\/3/);
  assert.match(lines[3]!, /\/p\/5/);
  assert.match(lines[1]!, /read/);
  assert.match(lines[2]!, /write/);
});

test("an empty log says so instead of rendering nothing", () => {
  assert.deepEqual(formatAudit([]), ["Scope log: nothing recorded yet"]);
});
