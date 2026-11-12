import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirectory, readText, searchPaths, type DirEntry } from "./files.ts";
import { sanitizeRelPath } from "./files-policy.ts";
import { TEXT_PREVIEW_MAX_BYTES } from "../shared/file-kind.ts";

test("sanitizeRelPath normalises separators and rejects traversal/absolute/encoded paths", () => {
  assert.deepEqual(sanitizeRelPath(""), { ok: true, rel: "" });
  assert.deepEqual(sanitizeRelPath("a/b.txt"), { ok: true, rel: "a/b.txt" });
  assert.deepEqual(sanitizeRelPath("a//b/./c"), { ok: true, rel: "a/b/c" });

  for (const bad of ["..", "../etc", "a/../../b", "a\\..\\b", "/etc", "C:\\x", "a%2fb", "a\0b"]) {
    assert.equal(sanitizeRelPath(bad).ok, false, `expected rejection: ${bad}`);
  }
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-files-test-"));
  await mkdir(join(root, "dir1", "sub"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "dir1", "a.txt"), "alpha\nbeta\n");
  await writeFile(join(root, "dir1", "sub", "b.md"), "# hi\n");
  await writeFile(join(root, "dir1", "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
  await writeFile(join(root, ".hidden"), "secret\n");
  await writeFile(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  await writeFile(join(root, "outside.txt"), "outside\n");
  await writeFile(join(root, "big.txt"), Buffer.alloc(TEXT_PREVIEW_MAX_BYTES + 64, 0x61));
  await writeFile(join(root, "target.txt"), "look for target\n");
  await symlink(join(root, "outside.txt"), join(root, "link.txt"));
  return root;
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

test("listDirectory sorts folders first and marks hidden and symlink entries", async () => {
  const root = await fixture();
  try {
    const result = await listDirectory(root, "", false);
    assert.equal("ok" in result ? result.ok : false, true);
    if (!("ok" in result) || !result.ok) return;
    const names = result.entries.map((entry) => entry.name);
    assert.ok(names.indexOf("dir1") < names.indexOf("target.txt"), "folders come before files");
    assert.ok(!names.includes(".hidden"), "hidden entries are excluded by default");
    const link = result.entries.find((entry) => entry.name === "link.txt");
    assert.equal(link?.kind, "symlink");
    const txt = result.entries.find((entry) => entry.name === "target.txt");
    assert.equal(txt?.fileKind, "text");
    assert.equal(typeof txt?.size, "number");
  } finally {
    await cleanup(root);
  }
});

test("listDirectory includes hidden entries only when asked", async () => {
  const root = await fixture();
  try {
    const result = await listDirectory(root, "", true);
    assert.ok("ok" in result && result.ok);
    if (!("ok" in result) || !result.ok) return;
    assert.ok(result.entries.some((entry) => entry.name === ".hidden"));
  } finally {
    await cleanup(root);
  }
});

test("listDirectory descends a nested relative path", async () => {
  const root = await fixture();
  try {
    const result = await listDirectory(root, "dir1/sub", false);
    assert.ok("ok" in result && result.ok);
    if (!("ok" in result) || !result.ok) return;
    assert.deepEqual(result.entries.map((entry) => entry.name), ["b.md"]);
    assert.equal(result.entries[0]?.fileKind, "markdown");
  } finally {
    await cleanup(root);
  }
});

test("readText returns text content and detects binary NUL bytes", async () => {
  const root = await fixture();
  try {
    const text = await readText(root, "dir1/a.txt");
    assert.ok("ok" in text && text.ok);
    if (!("ok" in text) || !text.ok) return;
    assert.equal(text.text, "alpha\nbeta\n");
    assert.equal(text.binary, false);
    assert.equal(text.truncated, false);

    const binary = await readText(root, "dir1/bin.dat");
    assert.ok("ok" in binary && binary.ok);
    if (!("ok" in binary) || !binary.ok) return;
    assert.equal(binary.binary, true);
  } finally {
    await cleanup(root);
  }
});

test("readText truncates a file past the preview cap", async () => {
  const root = await fixture();
  try {
    const big = await readText(root, "big.txt");
    assert.ok("ok" in big && big.ok);
    if (!("ok" in big) || !big.ok) return;
    assert.equal(big.truncated, true);
    assert.equal(big.text.length, TEXT_PREVIEW_MAX_BYTES);
  } finally {
    await cleanup(root);
  }
});

test("readText refuses a symlink and a directory", async () => {
  const root = await fixture();
  try {
    const link = await readText(root, "link.txt");
    assert.ok("ok" in link && link.ok === false);
    if ("ok" in link && !link.ok) assert.equal(link.code, "symlink");

    const dir = await readText(root, "dir1");
    assert.ok("ok" in dir && dir.ok === false);
    if ("ok" in dir && !dir.ok) assert.equal(dir.code, "not_file");
  } finally {
    await cleanup(root);
  }
});

test("searchPaths finds filenames recursively and skips heavy/hidden dirs", async () => {
  const root = await fixture();
  try {
    const result = await searchPaths(root, "target");
    assert.ok("ok" in result && result.ok);
    if (!("ok" in result) || !result.ok) return;
    assert.deepEqual(result.matches.map((match) => match.path), ["target.txt"]);

    // A search for a name that only exists under node_modules or hidden dirs finds nothing.
    const skipped = await searchPaths(root, "index.js");
    assert.ok("ok" in skipped && skipped.ok);
    if (!("ok" in skipped) || !skipped.ok) return;
    assert.equal(skipped.matches.length, 0);

    const hidden = await searchPaths(root, "hidden");
    assert.ok("ok" in hidden && hidden.ok);
    if (!("ok" in hidden) || !hidden.ok) return;
    assert.equal(hidden.matches.length, 0);
  } finally {
    await cleanup(root);
  }
});

test("searchPaths is case-insensitive on the basename", async () => {
  const root = await fixture();
  try {
    const result = await searchPaths(root, "TARGET");
    assert.ok("ok" in result && result.ok);
    if (!("ok" in result) || !result.ok) return;
    assert.deepEqual(result.matches.map((match) => match.name), ["target.txt"]);
  } finally {
    await cleanup(root);
  }
});

test("listDirectory returns not_directory for a file path", async () => {
  const root = await fixture();
  try {
    const result = await listDirectory(root, "dir1/a.txt", false);
    assert.ok("ok" in result && result.ok === false);
    if ("ok" in result && !result.ok) assert.equal(result.code, "not_directory");
  } finally {
    await cleanup(root);
  }
});

test("DirEntry files expose fileKind and metadata for the preview header", async () => {
  const root = await fixture();
  try {
    const result = await listDirectory(root, "dir1", false);
    assert.ok("ok" in result && result.ok);
    if (!("ok" in result) || !result.ok) return;
    const bin = result.entries.find((entry): entry is DirEntry & { fileKind: string } =>
      entry.kind === "file" && entry.name === "bin.dat",
    );
    assert.equal(bin?.fileKind, "binary");
  } finally {
    await cleanup(root);
  }
});