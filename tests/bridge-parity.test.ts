import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { MESSAGE_NAMES } from "../web/core/protocol/catalog.ts";
import { PARITY_BASELINE, parityMarkdown, type ParityRow } from "../web/core/protocol/parity.ts";

/**
 * A row keeps coverage only while all three cells still point at real things:
 * a catalog message, every adapter file and a test that declares tests and
 * names the surface it exercises (or runs the catalog-wide conformance suite).
 */
function coverageGaps(row: ParityRow): string[] {
  const gaps: string[] = [];
  for (const name of row.messages) {
    if (!MESSAGE_NAMES.includes(name as never)) gaps.push(`message ${name}`);
  }
  const adapterFiles = row.adapter.split(" + ").map((file) => file.trim());
  for (const file of adapterFiles) {
    if (!existsSync(file)) gaps.push(`adapter ${file}`);
  }
  const testFiles = row.test.split(" + ").map((file) => file.trim());
  const sources: string[] = [];
  for (const file of testFiles) {
    if (!existsSync(file)) {
      gaps.push(`test ${file}`);
      continue;
    }
    const source = readFileSync(file, "utf8");
    if (!/\btest\s*\(/.test(source)) gaps.push(`${file} declares no tests`);
    sources.push(source);
  }
  const stems = adapterFiles.map((file) => file.split("/").pop()?.replace(/\.(tsx?|mjs)$/, "") ?? "");
  const namesSurface = sources.some((source) => row.messages.some((name) => source.includes(name))
    || stems.some((stem) => stem !== "" && source.includes(stem))
    || source.includes("runConformance"));
  if (sources.length > 0 && !namesSurface) gaps.push(`${row.test} no longer names a message or adapter`);
  return gaps;
}

test("every parity row keeps its message, adapter and test coverage", () => {
  const gaps = PARITY_BASELINE.flatMap((row) => coverageGaps(row).map((gap) => `${row.area}: ${gap}`));
  assert.deepEqual(gaps, [], `parity rows lost coverage:\n  ${gaps.join("\n  ")}`);
});

test("coverage detection fails for a row that loses a message, adapter or test", () => {
  const broken: ParityRow = {
    area: "Detector self-test",
    baseline: "synthetic",
    messages: ["message.that.does.not.exist"],
    adapter: "web/core/adapters/missing.ts",
    test: "tests/missing.test.ts",
  };
  assert.deepEqual(coverageGaps(broken), [
    "message message.that.does.not.exist",
    "adapter web/core/adapters/missing.ts",
    "test tests/missing.test.ts",
  ]);
  const noTests: ParityRow = {
    ...broken,
    messages: ["settings.read"],
    adapter: "web/core/adapters/pi-api.ts",
    test: "web/core/protocol/envelope.test.ts",
  };
  assert.deepEqual(coverageGaps(noTests), ["web/core/protocol/envelope.test.ts no longer names a message or adapter"]);
});

test("the generated parity doc matches the baseline table", () => {
  assert.equal(readFileSync("docs/bridge-protocol-parity.md", "utf8"), parityMarkdown());
});
