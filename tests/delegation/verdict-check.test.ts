import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkEvidence, checkVerdicts, pathOfRef } from "../../lib/delegation/verdict-check.ts";

const dir = mkdtempSync(join(tmpdir(), "verdict-"));
mkdirSync(join(dir, "src"));
writeFileSync(join(dir, "src/a.ts"), "x");
const artifactExists = (id: string) => id === "report-api-1";
const opts = { cwd: dir, artifactExists };

describe("evidence checks", () => {
  it("verifies paths and artifacts, fails missing ones, attests the rest", () => {
    const out = checkEvidence(["src/a.ts:12", "src/missing.ts", "report-api-1", "artifact:report-nope-1", "https://x.test/p", "ran npm test", "I read it"], opts);
    assert.deepEqual(out.map((e) => e.kind), ["verified", "failed", "verified", "failed", "attested", "attested", "attested"]);
  });
  it("refuses paths that escape the working directory", () => {
    assert.equal(checkEvidence(["../../etc/passwd.conf"], opts)[0]!.kind, "failed");
  });
  it("pathOfRef strips line suffixes", () => {
    assert.equal(pathOfRef("src/a.ts#L9"), "src/a.ts");
    assert.equal(pathOfRef("just words"), undefined);
  });
});

describe("verdicts bind to the frozen criteria", () => {
  const frozen = ["retry budget is configurable", "errors are logged"];
  const ok = [
    { criterion: "1", met: true, evidence: ["src/a.ts:3"] },
    { criterion: "errors are logged", met: true, evidence: ["report-api-1", "ran npm test"] },
  ];

  it("accepts a complete, verified verdict set", () => {
    assert.deepEqual(checkVerdicts({ frozen, verdicts: ok, ...opts }).problems, []);
  });
  it("reports every uncovered criterion", () => {
    const { problems } = checkVerdicts({ frozen, verdicts: [ok[0]!], ...opts });
    assert.deepEqual(problems.map((p) => p.code), ["criteria-uncovered"]);
  });
  it("an unmet criterion cannot be accepted", () => {
    const { problems } = checkVerdicts({ frozen, verdicts: [ok[0]!, { ...ok[1]!, met: false }], ...opts });
    assert.ok(problems.some((p) => p.code === "criterion-unmet"));
  });
  it("attested-only evidence needs an explicit override", () => {
    const verdicts = [ok[0]!, { criterion: "2", met: true, evidence: ["ran npm test"] }];
    assert.ok(checkVerdicts({ frozen, verdicts, ...opts }).problems.some((p) => p.code === "evidence-unverifiable"));
    assert.deepEqual(checkVerdicts({ frozen, verdicts, ...opts, overrides: ["evidence-unverifiable"] }).problems, []);
  });
  it("a failed reference and an unknown criterion are problems", () => {
    const { problems } = checkVerdicts({
      frozen,
      verdicts: [{ criterion: "1", met: true, evidence: ["src/gone.ts", "src/a.ts"] }, { criterion: "9", met: true, evidence: [] }, ok[1]!],
      ...opts,
    });
    assert.deepEqual(problems.map((p) => p.code).sort(), ["criterion-unknown", "evidence-failed"]);
  });
});
