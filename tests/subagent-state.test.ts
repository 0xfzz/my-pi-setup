import assert from "node:assert/strict";
import test from "node:test";

import { launched } from "../lib/subagent-state.ts";

test("a resume driven by an answered escalation records the new run id", () => {
  const record = launched({
    status: "answered",
    id: "esc-60e6d450-1",
    sessionFile: "/s/child.jsonl",
    resumed: true,
    resumeRunId: "21b3ddba",
    paneId: "w4:pAF",
  }, { name: "F1" });
  assert.equal(record?.runId, "21b3ddba");
  assert.equal(record?.status, "running");
  assert.equal(record?.ended, false);
});

test("an escalation that did not resume records nothing", () => {
  assert.equal(launched({ status: "answered", id: "esc-1", sessionFile: "/s/c.jsonl", resumed: false }), undefined);
});

test("a normal launch still keys on the launch id", () => {
  assert.equal(launched({ status: "started", id: "abc12345", sessionFile: "/s/c.jsonl" })?.runId, "abc12345");
});
