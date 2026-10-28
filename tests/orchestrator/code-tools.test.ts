import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  codeMap,
  codeRead,
  languageOf,
  listRepoFiles,
  sha256,
  type CodeToolsDeps,
} from "../../lib/orchestrator/code-tools.ts";
import type { CommandResult } from "../../lib/orchestrator/search-engine.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orch-code-tools-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export function retry() {\n  return 1;\n}\nexport class Pool {}\n", "utf8");
  await writeFile(join(root, "src", "b.py"), "def handler():\n    pass\n", "utf8");
  await writeFile(join(root, "README.md"), "# Title\n", "utf8");
  return {
    root,
    deps: (responses: Array<Partial<CommandResult>> = []): CodeToolsDeps => {
      const runner = {
        async run(): Promise<CommandResult> {
          return { exitCode: 0, stdout: "src/a.ts\nsrc/b.py\nREADME.md\n", stderr: "", timedOut: false, ...responses.shift() };
        },
      };
      return { cwd: root, runner, guard: () => undefined };
    },
    detach: () => rm(root, { recursive: true, force: true }),
  };
}

test("code_map lists files with language, size and exported symbols", async () => {
  const h = await fixture();
  try {
    const map = await codeMap({}, h.deps());
    assert.equal(map.files.length, 3);
    const a = map.files.find((file) => file.path === "src/a.ts")!;
    assert.equal(a.language, "typescript");
    assert.ok(a.bytes > 0);
    assert.deepEqual(a.symbols?.map((symbol) => symbol.name), ["retry", "Pool"]);
    assert.equal(map.truncated, false);
  } finally {
    await h.detach();
  }
});

test("code_map truncates by file cap instead of returning everything", async () => {
  const h = await fixture();
  try {
    const map = await codeMap({ maxFiles: 2 }, h.deps());
    assert.equal(map.files.length, 2);
    assert.equal(map.truncated, true);
  } finally {
    await h.detach();
  }
});

test("file listing falls back to git ls-files when rg is unavailable", async () => {
  const h = await fixture();
  try {
    const deps = h.deps([{ exitCode: 2, stdout: "", stderr: "rg missing" }]);
    deps.runner = { async run() { return { exitCode: 0, stdout: "src/a.ts\nREADME.md\n", stderr: "", timedOut: false }; } };
    const files = await listRepoFiles({ maxFiles: 10 }, deps);
    assert.deepEqual(files, ["src/a.ts", "README.md"]);
  } finally {
    await h.detach();
  }
});

test("code_read returns a window with line numbers and a whole-file digest", async () => {
  const h = await fixture();
  try {
    const content = await readFile(join(h.root, "src", "a.ts"), "utf8");
    const read = codeRead({ path: "src/a.ts", start: 2, limit: 1 }, h.deps());
    assert.deepEqual(read.lines, [{ n: 2, text: "  return 1;" }]);
    assert.equal(read.digest, sha256(content), "the digest covers the whole file, not the window");
    assert.equal(read.truncated, true);
  } finally {
    await h.detach();
  }
});

test("code_read refuses an oversized file unless a range is given", async () => {
  const h = await fixture();
  try {
    assert.throws(() => codeRead({ path: "src/a.ts", maxBytes: 5 }, h.deps()), /over the 5-byte cap/);
    const ranged = codeRead({ path: "src/a.ts", start: 1, limit: 1, maxBytes: 5 }, h.deps());
    assert.equal(ranged.lines.length, 1);
  } finally {
    await h.detach();
  }
});

test("the caller's path guard refuses a read before it happens", async () => {
  const h = await fixture();
  try {
    const deps = h.deps();
    deps.guard = (candidate) => (candidate.includes("a.ts") ? "src/a.ts is outside the reviewer's roots" : undefined);
    assert.throws(() => codeRead({ path: "src/a.ts" }, deps), /outside the reviewer's roots/);
  } finally {
    await h.detach();
  }
});

test("languages map by extension and unknown extensions stay text", () => {
  assert.equal(languageOf("src/a.ts"), "typescript");
  assert.equal(languageOf("src/b.py"), "python");
  assert.equal(languageOf("notes.unknown"), "text");
});
