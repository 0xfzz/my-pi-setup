import test from "node:test";
import assert from "node:assert/strict";

import { balancedChunks, chunkCount } from "../../lib/orchestrator/chunking.ts";
import { planQaGroups } from "../../lib/orchestrator/qa-groups.ts";

const scopes = (n: number): string[] => Array.from({ length: n }, (_, i) => `unit-${i + 1}`);

test("chunk count is the smallest that respects the per-chunk cap, capped by maxChunks", () => {
  const options = { maxPerChunk: 3, maxChunks: 3 };
  assert.equal(chunkCount(0, options), 0);
  assert.equal(chunkCount(1, options), 1);
  assert.equal(chunkCount(3, options), 1);
  assert.equal(chunkCount(4, options), 2);
  assert.equal(chunkCount(5, options), 2);
  assert.equal(chunkCount(6, options), 2);
  assert.equal(chunkCount(7, options), 3);
  assert.equal(chunkCount(9, options), 3);
  // The cap wins over attention: nine is already the largest wave.
  assert.equal(chunkCount(27, options), 3);
});

test("five units split as 2 + 3 with the remainder on the later chunk", () => {
  assert.deepEqual(balancedChunks(scopes(5), 2), [
    ["unit-1", "unit-2"],
    ["unit-3", "unit-4", "unit-5"],
  ]);
});

test("the remainder placement is explicit and mirror-symmetric", () => {
  assert.deepEqual(
    balancedChunks(scopes(5), 2, { remainder: "first" }).map((chunk) => chunk.length),
    [3, 2],
  );
  assert.deepEqual(balancedChunks(scopes(7), 3).map((chunk) => chunk.length), [2, 2, 3]);
  assert.deepEqual(balancedChunks(scopes(7), 3, { remainder: "first" }).map((chunk) => chunk.length), [3, 2, 2]);
});

test("every unit lands in exactly one chunk, in input order", () => {
  for (let n = 1; n <= 9; n += 1) {
    const count = chunkCount(n, { maxPerChunk: 3, maxChunks: 3 });
    const chunks = balancedChunks(scopes(n), count);
    assert.equal(chunks.length, count);
    assert.deepEqual(chunks.flat(), scopes(n), `${n} units must be partitioned once each`);
    for (const chunk of chunks) {
      assert.ok(chunk.length >= 1, "no empty chunk");
      assert.ok(chunk.length <= 3, "no chunk over the cap");
    }
  }
});

test("a whole chunk count is required; an impossible split is a programming error", () => {
  assert.throws(() => balancedChunks(scopes(3), 0), /positive whole chunk count/);
  assert.throws(() => balancedChunks(scopes(3), 1.5), /positive whole chunk count/);
  assert.throws(() => balancedChunks(scopes(2), 3), /into 3 non-empty chunks/);
});

test("QA and spec review cannot drift: the QA split is the shared split", () => {
  for (let n = 1; n <= 9; n += 1) {
    const plan = planQaGroups(scopes(n));
    assert.equal(plan.ok, true, `${n} units should plan`);
    if (!plan.ok) continue;
    const shared = balancedChunks(scopes(n), chunkCount(n, { maxPerChunk: 3, maxChunks: 3 }));
    assert.deepEqual(plan.groups.map((group) => group.scopes), shared, `${n} units must split the same way in both phases`);
  }
});
