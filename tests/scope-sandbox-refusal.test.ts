import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalize } from "../lib/scope/paths.ts";
import { RefusalDeduper, scanRefusals } from "../lib/scope/sandbox/refusal.ts";

test("scanRefusals extracts paths from standard unix touch and mkdir refusal errors", () => {
  const touchErr = "touch: cannot touch '/srv/data/file.txt': Read-only file system";
  const touchHits = scanRefusals(touchErr);
  assert.equal(touchHits.length, 1);
  assert.equal(touchHits[0]?.path, canonicalize("/srv/data/file.txt"));

  const mkdirErr = "mkdir: cannot create directory '/var/www/site': Permission denied";
  const mkdirHits = scanRefusals(mkdirErr);
  assert.equal(mkdirHits.length, 1);
  assert.equal(mkdirHits[0]?.path, canonicalize("/var/www/site"));
});

test("scanRefusals extracts paths from shell redirection errors", () => {
  const shErr = "sh: 1: cannot create /etc/passwd: Permission denied";
  const hits = scanRefusals(shErr);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.path, canonicalize("/etc/passwd"));
});

test("scanRefusals extracts paths from Node.js, Python, and generic runtime exceptions", () => {
  const nodeErr = "Error: EACCES: permission denied, open '/srv/secret.json'\n    at Object.openSync (node:fs:580:18)";
  const nodeHits = scanRefusals(nodeErr);
  assert.equal(nodeHits.length, 1);
  assert.equal(nodeHits[0]?.path, canonicalize("/srv/secret.json"));

  const pyErr = "Traceback (most recent call last):\nPermissionError: [Errno 13] Permission denied: '/opt/app/out.log'";
  const pyHits = scanRefusals(pyErr);
  assert.equal(pyHits.length, 1);
  assert.equal(pyHits[0]?.path, canonicalize("/opt/app/out.log"));
});

test("scanRefusals ignores relative paths and virtual system files", () => {
  assert.deepEqual(scanRefusals("touch: cannot touch 'relative/path': Permission denied"), []);
  assert.deepEqual(scanRefusals("sh: 1: cannot create /dev/null: Permission denied"), []);
  assert.deepEqual(scanRefusals("cannot open /proc/sys/vm: Permission denied"), []);
  assert.deepEqual(scanRefusals("syntax error near unexpected token 'fi'"), []);
});

test("scanRefusals deduplicates repeated paths across lines", () => {
  const multiErr = [
    "touch: cannot touch '/srv/data/file.txt': Read-only file system",
    "touch: cannot touch '/srv/data/file.txt': Permission denied",
    "mkdir: cannot create directory '/srv/other': Permission denied",
  ].join("\n");

  const hits = scanRefusals(multiErr);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.path, canonicalize("/srv/data/file.txt"));
  assert.equal(hits[1]?.path, canonicalize("/srv/other"));
});

test("RefusalDeduper records and deduplicates queried paths across calls", () => {
  const deduper = new RefusalDeduper();
  const path = canonicalize("/srv/test");

  assert.equal(deduper.has(path), false);
  deduper.add(path);
  assert.equal(deduper.has(path), true);

  deduper.clear();
  assert.equal(deduper.has(path), false);
});
