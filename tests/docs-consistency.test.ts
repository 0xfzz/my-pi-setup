/**
 * Docs that point at nothing are worse than missing docs: they read as current
 * while sending the reader to a 404. CONTRIBUTING.md told every contributor to
 * follow `docs/TEMPLATE.md`, but that file did not exist, and nothing noticed.
 *
 * These checks are deliberately about links and structure, not prose. They fail
 * on the class of mistake a rename or a move introduces, which is exactly the
 * class this repository keeps making.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Notes that are infrastructure or measurement, not surface documentation. */
const NOT_SURFACE_DOCS = new Set(["TEMPLATE.md", "smell-baseline.md"]);

const read = (relative: string) => readFile(join(root, relative), "utf8");

/** Every relative markdown link in a file, as written. */
function markdownLinks(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1]!.trim();
    if (/^(?:[a-z]+:|#|\/\/)/i.test(target)) continue; // external, anchor or protocol-relative
    out.push(target.split("#")[0]!);
  }
  return out;
}

test("every relative link in the root docs resolves", async () => {
  const broken: string[] = [];
  for (const file of ["README.md", "CONTRIBUTING.md", "AGENTS.md"]) {
    const text = await read(file);
    for (const link of markdownLinks(text)) {
      if (!link) continue;
      if (!existsSync(resolve(root, dirname(file), link))) broken.push(`${file} -> ${link}`);
    }
  }
  assert.deepEqual(broken, [], `broken links found:\n  ${broken.join("\n  ")}`);
});

test("every docs/ note's relative links resolve", async () => {
  const broken: string[] = [];
  for (const name of await readdir(join(root, "docs"))) {
    if (!name.endsWith(".md")) continue;
    const file = `docs/${name}`;
    for (const link of markdownLinks(await read(file))) {
      if (!link) continue;
      if (!existsSync(resolve(root, "docs", link))) broken.push(`${file} -> ${link}`);
    }
  }
  assert.deepEqual(broken, [], `broken links found:\n  ${broken.join("\n  ")}`);
});

test("every surface note is indexed in the README documentation table", async () => {
  const readme = await read("README.md");
  const indexed = new Set(
    [...readme.matchAll(/\]\(docs\/([A-Za-z0-9._-]+\.md)\)/g)].map((m) => m[1]!),
  );
  const missing: string[] = [];
  for (const name of await readdir(join(root, "docs"))) {
    if (!name.endsWith(".md") || NOT_SURFACE_DOCS.has(name)) continue;
    if (!indexed.has(name)) missing.push(name);
  }
  assert.deepEqual(missing, [],
    `docs/ notes exist but are absent from the README table — add a row, or add the note to NOT_SURFACE_DOCS if it is not surface documentation:\n  ${missing.join("\n  ")}`);
});

test("every note carries the Part-of line that links it back to the README", async () => {
  const offenders: string[] = [];
  for (const name of await readdir(join(root, "docs"))) {
    if (!name.endsWith(".md")) continue;
    const head = (await read(`docs/${name}`)).split("\n").slice(0, 8).join("\n");
    if (!/^> Part of \[pi-workflow-extensions\]\(\.\.\/README\.md\)/m.test(head)) offenders.push(name);
  }
  assert.deepEqual(offenders, [],
    `these notes are missing the "> Part of [pi-workflow-extensions](../README.md)." line in their first 8 lines:\n  ${offenders.join("\n  ")}`);
});

test("the doc template the contributing guide links to exists and keeps its shape", async () => {
  const template = await read("docs/TEMPLATE.md");
  for (const marker of ["**Status**", "**Scope**", "**Verified against**", "## Detail", "## Tests", "## Removal"]) {
    assert.ok(template.includes(marker), `docs/TEMPLATE.md must keep the "${marker}" marker that CONTRIBUTING.md describes`);
  }
});

/** Directories under tests/ that hold helpers, not suites. */
const NOT_SUITE_DIRS = new Set(["fixtures"]);

test("the test runner covers every suite directory under tests/", async () => {
  // A nested suite directory that no glob matches runs zero tests while the run
  // still reports success. This happened when tests/provider/ was introduced.
  // The tiered runner walks tests/ recursively, so the invariant is now that
  // package.json goes through it, the walk is recursive, and every tier entry
  // names a real test file.
  const pkg = JSON.parse(await read("package.json"));
  assert.match(pkg.scripts.test, /scripts\/test\.mjs all/, "scripts.test must go through the tiered runner");
  const runner = await read("scripts/test.mjs");
  assert.match(runner, /readdirSync/, "the runner must walk tests/ recursively, not rely on a fixed glob list");
  const tiers = JSON.parse(await read("tests/tiers.json"));
  for (const file of tiers.integration ?? []) {
    assert.ok(file.endsWith(".test.ts"), `tiers.json must list test files: ${file}`);
    assert.ok(existsSync(resolve(root, file)), `tiers.json references a missing test: ${file}`);
  }
  for (const entry of await readdir(join(root, "tests"), { withFileTypes: true })) {
    if (!entry.isDirectory() || NOT_SUITE_DIRS.has(entry.name)) continue;
    const files = await readdir(join(root, "tests", entry.name));
    assert.ok(
      files.some((name) => name.endsWith(".test.ts")),
      `tests/${entry.name}/ has no *.test.ts files, so it is a helper directory and belongs in NOT_SUITE_DIRS`,
    );
  }
});
