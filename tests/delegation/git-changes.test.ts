import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attributeChanges, changedSince, snapshotTree } from "../../lib/delegation/git-changes.ts";
import { checkResult } from "../../lib/delegation/result-check.ts";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "git-changes-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "a");
  return dir;
}

describe("working-tree attribution", () => {
  it("sees a write made without any write/edit tool call", () => {
    const dir = repo();
    const before = snapshotTree(dir)!;
    writeFileSync(join(dir, "src/b.ts"), "sed -i did this"); // as bash would
    const changed = changedSince(before, snapshotTree(dir)!);
    assert.deepEqual(changed, ["src/b.ts"]);
  });

  it("a non-git directory is unknown, never clean", () => {
    assert.equal(snapshotTree(mkdtempSync(join(tmpdir(), "no-git-"))), null);
  });

  it("holds only unowned paths against the child", () => {
    const a = attributeChanges({
      changed: ["src/api/x.ts", "src/other/y.ts", "docs/z.md", "mine.md"],
      ownLane: ["src/api/"],
      otherLanes: ["src/other/"],
      parentWrites: ["mine.md"],
    });
    assert.deepEqual(a.inLane, ["src/api/x.ts"]);
    assert.deepEqual(a.elsewhere, ["src/other/y.ts", "mine.md"]);
    assert.deepEqual(a.unowned, ["docs/z.md"]);
  });
});

describe("receipt: unowned-change", () => {
  const base = { sessionFile: "/tmp/none.jsonl", scope: "s", laneFiles: [], cwd: "/", outcome: "completed" as const };
  it("is blocking, and only advisory when the parent also ran shell commands", () => {
    const blocking = checkResult({ ...base, tree: { unowned: ["x.ts"], ambiguous: false } });
    assert.ok(blocking.issues.some((i) => i.code === "unowned-change" && i.blocking));
    const soft = checkResult({ ...base, tree: { unowned: ["x.ts"], ambiguous: true } });
    assert.ok(soft.issues.some((i) => i.code === "unowned-change" && !i.blocking));
  });
});
