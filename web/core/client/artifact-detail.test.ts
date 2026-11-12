import test from "node:test";
import assert from "node:assert/strict";
import { artifactBodyKind, parseArtifactDetail } from "../../plugins/artifacts/artifact-detail.ts";

const metaLine = 'id:auth-spec · type:plan · version:3 · size:1.2 KB · author:subagent:worker:run1 · updated:2026-11-12T19:15:44.123Z · tags:["a","b"]';

test("a metadata line plus blank line parses into structured fields and content", () => {
  const parsed = parseArtifactDetail(`${metaLine}\n\n# Spec\n\nBody text`);
  assert.equal(parsed.meta.id, "auth-spec");
  assert.equal(parsed.meta.type, "plan");
  assert.equal(parsed.meta.version, 3);
  assert.equal(parsed.meta.size, "1.2 KB");
  assert.equal(parsed.meta.author, "subagent:worker:run1");
  assert.equal(parsed.meta.updatedAt, "2026-11-12T19:15:44.123Z");
  assert.deepEqual(parsed.meta.tags, ["a", "b"]);
  assert.equal(parsed.content, "# Spec\n\nBody text");
});

test("values after the first colon are preserved verbatim", () => {
  const parsed = parseArtifactDetail("id:x · type:code · version:7 · size:0 B · author:a:b:c · updated:2026-01-01T00:00:00.000Z · tags:[]\n\nfn main() {}");
  assert.equal(parsed.meta.author, "a:b:c");
  assert.equal(parsed.meta.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(parsed.content, "fn main() {}");
});

test("a body without a blank line is treated as content with fallback metadata", () => {
  const parsed = parseArtifactDetail("just some content");
  assert.equal(parsed.meta.id, "");
  assert.equal(parsed.meta.type, "other");
  assert.equal(parsed.meta.version, 1);
  assert.equal(parsed.content, "just some content");
});

test("malformed tags and versions degrade without throwing", () => {
  const parsed = parseArtifactDetail("id:x · type:code · version:NaN · tags:{oops}\n\nbody");
  assert.equal(parsed.meta.version, 1);
  assert.deepEqual(parsed.meta.tags, []);
  assert.equal(parsed.content, "body");
});

test("leading blank lines after the separator are trimmed", () => {
  const parsed = parseArtifactDetail("id:x · type:other · version:1\n\n\n\nbody");
  assert.equal(parsed.content, "body");
});

test("artifactBodyKind treats only the code type as code", () => {
  assert.equal(artifactBodyKind("code"), "code");
  assert.equal(artifactBodyKind("plan"), "markdown");
  assert.equal(artifactBodyKind(""), "markdown");
});