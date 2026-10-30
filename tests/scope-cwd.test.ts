import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveBase } from "../lib/scope/cwd.ts";

const cwd = "/work";

test("no prefix means the session cwd", () => {
  assert.deepEqual(effectiveBase(cwd, undefined), { base: cwd });
  assert.deepEqual(effectiveBase(cwd, "   "), { base: cwd });
});

test("a cd in the prefix moves the base", () => {
  // The `&&` is part of how a real prefix is written; it has no cwd effect and must
  // not make the prefix look like incomplete syntax.
  assert.equal(effectiveBase(cwd, "cd /repo &&").base, "/repo");
  assert.equal(effectiveBase(cwd, "cd sub && cd nested &&").base, "/work/sub/nested");
  assert.equal(effectiveBase(cwd, "cd .. &&").base, "/");
});

test("a prefix that does not move the directory is transparent", () => {
  // The common setup: source a version manager, export a variable, then run.
  assert.deepEqual(effectiveBase(cwd, "source ~/.nvm/nvm.sh &&"), { base: cwd });
  assert.deepEqual(effectiveBase(cwd, "export NODE_ENV=test &&"), { base: cwd });
});

test("a cd inside a subshell does not move the outer base", () => {
  assert.equal(effectiveBase(cwd, "(cd /tmp; ls) &&").base, cwd);
});

test("a cd whose target cannot be resolved is reported, not guessed", () => {
  const result = effectiveBase(cwd, "cd $DEPLOY_DIR &&");
  assert.equal(result.base, cwd, "the base stays the cwd rather than becoming nonsense");
  assert.match(result.opaque ?? "", /cannot resolve/);
});

test("an unreadable prefix is only opaque when it may have moved the directory", () => {
  // `source` with a glob cannot be lowered, but it cannot change the cwd either.
  assert.deepEqual(effectiveBase(cwd, "source ./scripts/*.sh &&"), { base: cwd });
  // A cd target that is itself a pattern could match several directories, so the
  // base would be a guess and is reported instead.
  const moving = effectiveBase(cwd, "cd ./build/* &&");
  assert.match(moving.opaque ?? "", /cannot resolve/);
});
