import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalize, classifyPath, expandHome, lexicalInside, suggestGrant, toResourceSlash } from "../lib/scope/paths.ts";
import { isUnsafeRoot, type ScopeRoot } from "../lib/scope/types.ts";

const root = (path: string, access: "ro" | "rw" = "rw"): ScopeRoot => ({ path, access, source: "session" });

test("~ and $HOME expand only at the start of a path", () => {
  assert.equal(expandHome("~/notes/x.md", "/home/u"), "/home/u/notes/x.md");
  assert.equal(expandHome("~", "/home/u"), "/home/u");
  assert.equal(expandHome("$HOME/x", "/home/u"), "/home/u/x");
  assert.equal(expandHome("/tmp/~/x", "/home/u"), "/tmp/~/x", "an inner tilde is a literal directory name");
  assert.equal(expandHome("~", ""), "~", "without a home directory the value is left alone");
});

test("resource spelling uses forward slashes and drops a trailing separator", () => {
  assert.equal(toResourceSlash("src\\deep\\"), "src/deep");
  assert.equal(toResourceSlash("/"), "/");
});

test("containment does not confuse a sibling with a shared prefix", () => {
  assert.equal(lexicalInside("/a/b", "/a/b/c"), true);
  assert.equal(lexicalInside("/a/b", "/a/b"), true);
  assert.equal(lexicalInside("/a/b", "/a/bc"), false);
  assert.equal(lexicalInside("/a/b", "/a/b/../c"), false);
});

test("canonicalize resolves symlinked ancestors and keeps a not-yet-created suffix", () => {
  const links: Record<string, string> = { "/repo/link": "/etc" };
  const realpath = (path: string) => {
    if (links[path]) return links[path]!;
    if (path.startsWith("/etc/")) return path;
    if (linkTarget(path)) return path;
    throw new Error("ENOENT");
  };
  const existing = new Set(["/repo", "/etc", "/etc/ssl"]);
  const linkTarget = (path: string) => existing.has(path) || links[path] !== undefined;
  assert.equal(canonicalize("/repo/link/ssl/cert.pem", realpath), "/etc/ssl/cert.pem");
  assert.equal(canonicalize("/repo/new/dir/file.txt", realpath), "/repo/new/dir/file.txt");
});

test("classifyPath keeps the workspace internal and reports the outside as external", () => {
  const roots = [root("/work")];
  const inside = classifyPath("/work", roots, "src/a.ts", { home: "/home/u" });
  assert.equal(inside.external, false);
  assert.equal(inside.resource, "src/a.ts");

  const outside = classifyPath("/work", roots, "../other/a.ts", { home: "/home/u" });
  assert.equal(outside.external, true);
  assert.equal(outside.resource, "/other/a.ts");
});

test("classifyPath judges a symlink by its target, not by its name", () => {
  const roots = [root("/work")];
  const links: Record<string, string> = { "/work/link": "/etc" };
  const existing = new Set(["/work", "/etc"]);
  const realpath = (path: string) => {
    if (links[path]) return links[path]!;
    if (existing.has(path)) return path;
    throw new Error("ENOENT");
  };
  const leaked = classifyPath("/work", roots, "link/passwd", { realpath });
  assert.equal(leaked.external, true, "a link inside the workspace must not launder an outside path");
  assert.equal(leaked.resource, "/etc/passwd");
});

test("a nested read-only root narrows only itself", () => {
  const roots = [root("/work"), root("/work/vendor", "ro")];
  const vendored = classifyPath("/work", roots, "vendor/lib.ts");
  assert.equal(vendored.root?.path, "/work/vendor");
  assert.equal(vendored.root?.access, "ro");
  assert.equal(classifyPath("/work", roots, "src/a.ts").root?.path, "/work");
});

test("suggestGrant offers the containing directory, with its literal glob", () => {
  const suggestion = suggestGrant("/home/u/other/a.ts", { cwd: "/work", home: "/home/u", kind: "file", access: "ro" });
  assert.equal(suggestion.path, "/home/u/other");
  assert.equal(suggestion.glob, "/home/u/other/*");
  assert.equal(suggestion.exact, false);
});

test("suggestGrant degrades to one file instead of granting home, root or the workspace's parent", () => {
  for (const [path, kind] of [
    ["/home/u/.bashrc", "file"],
    ["/home/u", "directory"],
    ["/etc/passwd", "file"],
  ] as const) {
    const home = path === "/etc/passwd" ? undefined : "/home/u";
    const suggestion = suggestGrant(path, { cwd: "/home/u/work", home, kind, access: "ro" });
    assert.equal(suggestion.exact, true, `${path} must not produce a directory grant`);
    assert.equal(suggestion.glob, path);
  }
  // A directory that contains the workspace would re-expose every sibling project.
  const parent = suggestGrant("/home/u/work/a.ts", { cwd: "/home/u/work/app", home: "/home/u", kind: "file", access: "ro" });
  assert.equal(parent.exact, true);
  assert.ok(isUnsafeRoot("/", undefined));
  assert.ok(isUnsafeRoot("C:\\", undefined));
});

test("a wildcard root covers the tree it names, and the literal prefix decides specificity", () => {
  const roots: ScopeRoot[] = [root("/data/projects"), { ...root("/data/projects/*", "ro"), source: "config" }];
  const inside = classifyPath("/data/projects/a", roots, "/data/projects/app/src/a.ts");
  assert.equal(inside.external, false, "a glob root covers a descendant");
  assert.equal(inside.root?.path, "/data/projects/*", "the narrower literal prefix wins");
  assert.equal(inside.resource, "/data/projects/app/src/a.ts", "a glob root has no directory to be relative to");

  const outside = classifyPath("/data/projects/a", [root("/data/projects/*")], "/data/other/a.ts");
  assert.equal(outside.external, true, "a glob root covers only what it matches");
});
