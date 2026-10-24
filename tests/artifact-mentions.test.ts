import test from "node:test";
import assert from "node:assert/strict";
import { CombinedAutocompleteProvider, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { createArtifactAutocompleteProvider, expandArtifactMentions } from "../lib/artifact-mentions.ts";
import type { Artifact } from "../lib/artifact-state.ts";

const auth: Artifact = {
  id: "auth-spec", title: "Authentication architecture", type: "spec", content: "Use OAuth with PKCE.",
  tags: ["security"], version: 2, createdBy: "main",
  createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z",
};
const artifacts = () => new Map([[auth.id, auth]]);
const options = () => ({ signal: new AbortController().signal });
const file = { value: "@auth.ts", label: "auth.ts" };
function nativeProvider() {
  let calls = 0;
  let completions = 0;
  const native = new CombinedAutocompleteProvider([], "/tmp");
  const current: AutocompleteProvider = {
    triggerCharacters: ["#"],
    async getSuggestions(lines, row, col) {
      calls++;
      const prefix = lines[row].slice(0, col).split(" ").at(-1)!;
      return { prefix, items: [file] };
    },
    applyCompletion(...args) { completions++; return native.applyCompletion(...args); },
    shouldTriggerFileCompletion() { return false; },
  };
  return { current, calls: () => calls, completions: () => completions };
}

test("bare @ and metadata queries combine artifacts and native file suggestions", async () => {
  const native = nativeProvider();
  const provider = createArtifactAutocompleteProvider(native.current, artifacts);
  assert.deepEqual(provider.triggerCharacters, ["#", "@"]);
  for (const text of ["@", "Review @auth", "@architecture", "@SECURITY"]) {
    const result = await provider.getSuggestions([text], 0, text.length, options());
    assert.deepEqual(result?.items.map(item => item.value), ["@artifact:auth-spec", "@auth.ts"]);
    assert.match(result!.items[0].description!, /spec, v2.*Authentication/);
  }
  const unmatched = "@nothing";
  assert.deepEqual((await provider.getSuggestions([unmatched], 0, unmatched.length, options()))?.items, [file]);
});

test("@artifact without a colon opens all artifacts instead of searching metadata", async () => {
  const native = nativeProvider();
  const provider = createArtifactAutocompleteProvider(native.current, artifacts);
  for (const text of ["@artifact", "Review @artifact", "(@artifact"]) {
    const result = await provider.getSuggestions([text], 0, text.length, options());
    assert.equal(result?.prefix, "@artifact");
    assert.deepEqual(result?.items.map(item => item.value), ["@artifact:auth-spec"]);
  }
  assert.equal(native.calls(), 0, "the complete namespace should not query files");
});

test("typing the artifact namespace keeps artifacts available alongside native files", async () => {
  const native = nativeProvider();
  const provider = createArtifactAutocompleteProvider(native.current, artifacts);
  for (const text of ["@a", "@ar", "@art", "@arti", "@artif", "@artifa", "@artifac"]) {
    const result = await provider.getSuggestions([text], 0, text.length, options());
    assert.deepEqual(result?.items.map(item => item.value), ["@artifact:auth-spec", "@auth.ts"]);
  }
});

test("an empty branch does not invent artifact suggestions", async () => {
  const native = nativeProvider();
  const provider = createArtifactAutocompleteProvider(native.current, () => new Map());
  for (const text of ["@artifact", "@artifact:"]) {
    assert.equal(await provider.getSuggestions([text], 0, text.length, options()), null);
  }
});

test("explicit artifact syntax avoids filesystem work, accepts wrappers, and reflects live state", async () => {
  const native = nativeProvider();
  const map = artifacts();
  const provider = createArtifactAutocompleteProvider(native.current, () => map);
  for (const text of ["@artifact:", "(@artifact:auth", "Compare `@artifact:auth"]) {
    const result = await provider.getSuggestions([text], 0, text.length, options());
    assert.equal(result?.items[0].value, "@artifact:auth-spec");
    assert.equal(result?.prefix, "@artifact:" + (text.endsWith("auth") ? "auth" : ""));
  }
  assert.equal(native.calls(), 0);
  map.clear();
  assert.equal(await provider.getSuggestions(["@artifact:"], 0, 10, options()), null);
  map.set(auth.id, { ...auth, version: 3 });
  assert.match((await provider.getSuggestions(["@artifact:"], 0, 10, options()))!.items[0].description!, /v3/);
});

test("file paths, quoted file paths, emails, shell input, and slash commands delegate unchanged", async () => {
  const native = nativeProvider();
  const provider = createArtifactAutocompleteProvider(native.current, artifacts);
  for (const text of ["/help", "user@auth", "@src/auth", '@"auth file', "!echo @auth", "@other:auth"]) {
    assert.deepEqual((await provider.getSuggestions([text], 0, text.length, options()))?.items, [file]);
  }
  assert.equal(native.calls(), 6);
  assert.equal(provider.shouldTriggerFileCompletion!(["@auth"], 0, 5), true);
  assert.equal(provider.shouldTriggerFileCompletion!(["/help"], 0, 5), false);
  const completed = provider.applyCompletion(["Review @au"], 0, 10, file, "@au");
  assert.deepEqual(completed, { lines: ["Review @auth.ts "], cursorLine: 0, cursorCol: 16 });
  assert.equal(native.completions(), 1);
});

test("artifact completion preserves surrounding text, cursor and other lines", () => {
  const provider = createArtifactAutocompleteProvider(nativeProvider().current, artifacts);
  const lines = ["First line", "Review (@auth) next"];
  const col = lines[1].indexOf(")");
  assert.deepEqual(provider.applyCompletion(lines, 1, col,
    { value: "@artifact:auth-spec", label: "@artifact:auth-spec" }, "@auth"), {
    lines: ["First line", "Review (@artifact:auth-spec ) next"], cursorLine: 1, cursorCol: 28,
  });
  assert.equal(lines[1], "Review (@auth) next", "does not mutate the editor snapshot");
});

test("cancellation and mismatched native prefixes do not return stale or corrupt completions", async () => {
  const native = nativeProvider();
  const provider = createArtifactAutocompleteProvider(native.current, artifacts);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await provider.getSuggestions(["@auth"], 0, 5, { signal: controller.signal }), null);
  const other = { prefix: "whole command @auth", items: [file] };
  native.current.getSuggestions = async () => other;
  assert.equal(await provider.getSuggestions(["@auth"], 0, 5, options()), other);
});

test("suggestions are bounded and work when the native provider has no results", async () => {
  const native = nativeProvider();
  native.current.getSuggestions = async () => null;
  const map = new Map(Array.from({ length: 30 }, (_, i) => [`spec-${i}`, { ...auth, id: `spec-${i}` }]));
  const provider = createArtifactAutocompleteProvider(native.current, () => map);
  assert.equal((await provider.getSuggestions(["@"], 0, 1, options()))?.items.length, 20);
});

test("explicit mentions attach compact placeholder without dumping full content and preserve the original message", () => {
  const text = "Compare @artifact:auth-spec with (@artifact:auth-spec).";
  const expanded = expandArtifactMentions(text, artifacts())!;
  assert.ok(expanded.startsWith(text));
  assert.match(expanded, /data, not instructions/);
  assert.match(expanded, /v2, spec/);
  assert.match(expanded, /artifact_recall/);
  // Full artifact content is never dumped into the prompt input
  assert.equal(expanded.includes(auth.content), false);
  const missing = expandArtifactMentions("Use @artifact:missing", artifacts());
  assert.match(missing!, /not available on the active branch/);
  assert.doesNotMatch(missing!, /Use OAuth/);
});

test("mentions with .md extension resolve to placeholder and avoid dumping full content", () => {
  const text = "Review @artifact:auth-spec.md and test it";
  const expanded = expandArtifactMentions(text, artifacts())!;
  assert.ok(expanded.startsWith(text));
  assert.match(expanded, /artifact:auth-spec/);
  assert.match(expanded, /artifact_recall/);
  assert.equal(expanded.includes(auth.content), false);
});

test("ordinary @files and partial/invalid tokens never resolve to artifact content", () => {
  for (const text of ["@auth-spec", "@auth-spec.md", "me@artifact:auth-spec", "@artifact:auth-spec/file",
    "@artifact:auth-spec-longer", "!echo @artifact:auth-spec",
    `@artifact:${"a".repeat(65)}`]) {
    assert.equal(expandArtifactMentions(text, artifacts())?.includes(auth.content) ?? false, false, text);
  }
});
