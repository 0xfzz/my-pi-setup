import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createScheduler,
  parseGrepLines,
  parseRgJson,
  runSearch,
  type CommandResult,
  type SearchDeps,
  type SearchRequest,
} from "../../lib/orchestrator/search-engine.ts";

function fakeRunner(responses: Array<Partial<CommandResult>> = []) {
  const calls: Array<{ bin: string; argv: string[] }> = [];
  return {
    calls,
    async run(bin: string, argv: string[]): Promise<CommandResult> {
      calls.push({ bin, argv });
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...(responses.shift() ?? {}) };
    },
  };
}

const request = (overrides: Partial<SearchRequest> = {}): SearchRequest => ({
  patterns: ["needle"],
  cwd: "/repo",
  ...overrides,
});

const rgMatch = (path = "src/a.ts", line = 2, text = "needle here\n") =>
  JSON.stringify({
    type: "match",
    data: { path: { text: path }, line_number: line, lines: { text }, submatches: [{ start: 0, end: 6 }] },
  });

test("rg is spawned with an argv array, fixed strings, and a -- terminator", async () => {
  const runner = fakeRunner([{ exitCode: 1, stdout: "" }]);
  await runSearch(request({ path: "src" }), { runner, engines: ["rg"] });
  const call = runner.calls[0]!;
  assert.equal(call.bin, "rg");
  assert.ok(call.argv.includes("--json"));
  assert.ok(call.argv.includes("--fixed-strings"));
  assert.ok(call.argv.includes("--regexp"));
  assert.ok(call.argv.includes("needle"));
  assert.equal(call.argv.at(-1), "src");
  assert.equal(call.argv.at(-2), "--", "patterns and paths are separated from flags");
});

test("rg JSON becomes matches with surrounding context", () => {
  const stdout = [
    JSON.stringify({ type: "begin", data: { path: { text: "src/a.ts" } } }),
    JSON.stringify({ type: "context", data: { lines: { text: "before\n" } } }),
    rgMatch(),
    JSON.stringify({ type: "context", data: { lines: { text: "after\n" } } }),
  ].join("\n");

  const parsed = parseRgJson(stdout, 10);
  assert.equal(parsed.matches.length, 1);
  assert.deepEqual(parsed.matches[0], {
    path: "src/a.ts",
    line: 2,
    column: 1,
    text: "needle here",
    before: ["before"],
    after: ["after"],
  });
  assert.equal(parsed.truncated, false);
});

test("the match cap marks the result truncated instead of silently stopping", () => {
  const stdout = [rgMatch("a.ts", 1), rgMatch("a.ts", 2)].join("\n");
  const parsed = parseRgJson(stdout, 1);
  assert.equal(parsed.matches.length, 1);
  assert.equal(parsed.truncated, true);
});

test("a timeout returns partial matches with a warning", async () => {
  const runner = fakeRunner([{ timedOut: true, stdout: rgMatch() }]);
  const result = await runSearch(request(), { runner, engines: ["rg"] });
  assert.equal(result.matches.length, 1, "partial output is kept");
  assert.equal(result.truncated, true);
  assert.match(result.warnings.join(" "), /timed out/);
});

test("a failing engine falls through to the next one", async () => {
  const runner = fakeRunner([
    { exitCode: 2, stdout: "", stderr: "rg exploded" },
    { exitCode: 0, stdout: "src/x.ts:3:1:needle\n" },
  ]);
  const result = await runSearch(request(), { runner, engines: ["rg", "grep"] });
  assert.equal(result.engine, "grep");
  assert.equal(result.matches[0]?.path, "src/x.ts");
  assert.match(result.warnings.join(" "), /rg failed/);
});

test("the host index adapter wins when it returns matches", async () => {
  const runner = fakeRunner();
  const deps: SearchDeps = {
    runner,
    hostSearch: () => ({ engine: "host", matches: [{ path: "a.ts", line: 1, column: 1, text: "hit", before: [], after: [] }], truncated: false, warnings: [] }),
  };
  const result = await runSearch(request(), deps);
  assert.equal(result.engine, "host");
  assert.equal(runner.calls.length, 0, "no process is spawned when the index answers");
});

test("at most two engine processes run at once", async () => {
  const schedule = createScheduler(2);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      schedule(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      }),
    ),
  );
  assert.ok(peak <= 2, `peak concurrency was ${peak}`);
});

test("grep output parses path, line, column and text", () => {
  const parsed = parseGrepLines("src/a.ts:4:7:needle\nsrc/b.ts:1:1:other\n", 10);
  assert.deepEqual(parsed.matches.map((match) => [match.path, match.line, match.column]), [
    ["src/a.ts", 4, 7],
    ["src/b.ts", 1, 1],
  ]);
});

test("the search module never walks the tree in JavaScript", () => {
  const source = readFileSync(join(import.meta.dirname, "../../lib/orchestrator/search-engine.ts"), "utf8");
  assert.doesNotMatch(source, /\breaddir(Sync)?\b|\bopendir(Sync)?\b/);
});
