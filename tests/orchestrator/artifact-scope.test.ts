import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  sanitizeScope,
  getSpecDeliveryDir,
  getSpecFilePath,
  createWorkSpecContent,
  writeWorkSpec,
  parseSpecLaneFiles,
} from "../../lib/orchestrator/artifact-scope.ts";

describe("artifact-scope helpers", () => {
  it("sanitizeScope allows valid slugs and rejects invalid/reserved ones", () => {
    assert.equal(sanitizeScope("auth-module"), "auth-module");
    assert.equal(sanitizeScope("DB_Layer_1"), "db-layer-1");
    assert.equal(sanitizeScope("  special.chars!@#$  "), "special-chars");

    assert.throws(() => sanitizeScope("global"), /Invalid scope identifier/);
    assert.throws(() => sanitizeScope("."), /Invalid scope identifier/);
    assert.throws(() => sanitizeScope(".."), /Invalid scope identifier/);
    assert.throws(() => sanitizeScope(""), /Invalid scope identifier/);
  });

  it("getSpecFilePath and getSpecDeliveryDir build canonical paths", () => {
    const base = "/tmp/artifacts";
    const dir = getSpecDeliveryDir(base, "parent-sess", "child-run-1");
    assert.equal(dir, "/tmp/artifacts/parent-sess/child-run-1");

    const specPath = getSpecFilePath(base, "parent-sess", "child-run-1", "auth-module");
    assert.equal(specPath, "/tmp/artifacts/parent-sess/child-run-1/auth-module.spec.md");
  });

  it("createWorkSpecContent includes scope, criteria, lane files, and contract rules", () => {
    const content = createWorkSpecContent({
      scope: "net-layer",
      goal: "Make retry backoff exponential with jitter.",
      acceptanceCriteria: ["Exponential backoff with jitter", "Pass unit tests"],
      laneFiles: ["src/net/client.ts", "src/net/backoff.ts"],
      outOfLaneFiles: ["src/auth/jwt.ts"],
      reportShape: "Summary with code snippets.",
    });

    // Canonical headings: there is exactly one renderer, so these strings are the
    // contract both the child ticket and the audit copy are built from.
    assert.ok(content.includes("# Work handoff: net-layer"));
    assert.ok(content.includes("## Goal"));
    assert.ok(content.includes("Make retry backoff exponential with jitter."));
    assert.ok(content.includes("1. Exponential backoff with jitter"));
    assert.ok(content.includes("2. Pass unit tests"));
    assert.ok(content.includes("- `src/net/client.ts`"));
    // Out-of-lane files are labelled as forbidden, not merely listed.
    assert.ok(content.includes("## Do NOT touch"));
    assert.ok(content.includes("- `src/auth/jwt.ts`"));
    // The two escalation routes are stated, in order, on every handoff.
    assert.ok(content.includes("## If you are unsure — escalate, never guess"));
    assert.ok(content.includes("`caller_ping`"));
    assert.ok(content.includes("it escalates to the user"));
    assert.ok(content.includes("Never resolve an ambiguity by picking the interpretation"));
    // Lane ownership is stated as a boundary, not a suggestion.
    assert.ok(content.includes("## Boundaries"));
    assert.ok(content.includes("write only inside your lane"));
    // A child is never told another scope exists.
    assert.ok(!/sibling/i.test(content));
  });

  it("writeWorkSpec creates private directory (0700) and private spec file (0600)", () => {
    const root = mkdtempSync(join(tmpdir(), "spec-test-"));
    try {
      const specPath = writeWorkSpec(root, "p-sess", "run-1", {
        scope: "sec-lane",
        acceptanceCriteria: ["Audit passwords"],
        laneFiles: ["src/sec.ts"],
      });

      const dirStat = statSync(join(root, "p-sess", "run-1"));
      // 0700 in octal
      assert.equal(dirStat.mode & 0o777, 0o700);

      const fileStat = statSync(specPath);
      // 0600 in octal
      assert.equal(fileStat.mode & 0o777, 0o600);

      const content = readFileSync(specPath, "utf8");
      assert.ok(content.includes("sec-lane"));
      const parsedLanes = parseSpecLaneFiles(content);
      assert.deepEqual(parsedLanes, ["src/sec.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parseSpecLaneFiles extracts files from markdown list", () => {
    const markdown = `# Spec
## Files in lane
- \`src/net/client.ts\`
- \`src/net/backoff.ts\`
* \`config/network.json\`
- (any other files)

## Acceptance criteria
1. test
`;
    const lanes = parseSpecLaneFiles(markdown);
    assert.deepEqual(lanes, ["src/net/client.ts", "src/net/backoff.ts", "config/network.json"]);
  });
});
