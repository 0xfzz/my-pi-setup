import test from "node:test";
import assert from "node:assert/strict";
import { splitMarkdownChunks } from "./markdown-chunks.ts";

test("a blank line between paragraphs closes the first one as a stable chunk", () => {
  assert.deepEqual(splitMarkdownChunks("first\n\nsecond"), {
    stable: ["first"],
    open: "second",
  });
});

test("text with no blank line after it stays entirely in the open chunk", () => {
  assert.deepEqual(splitMarkdownChunks("still typing"), { stable: [], open: "still typing" });
});

test("empty text has no stable chunks and an empty open chunk", () => {
  assert.deepEqual(splitMarkdownChunks(""), { stable: [], open: "" });
});

test("a blank line inside an unclosed code fence does not split the block", () => {
  assert.deepEqual(splitMarkdownChunks("```ts\nconst a = 1;\n\nconst b = 2;"), {
    stable: [],
    open: "```ts\nconst a = 1;\n\nconst b = 2;",
  });
});

test("a fence becomes a stable chunk once it closes and a blank line follows", () => {
  assert.deepEqual(splitMarkdownChunks("```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nafter"), {
    stable: ["```ts\nconst a = 1;\n\nconst b = 2;\n```"],
    open: "after",
  });
});

test("a shorter fence line inside a longer fence does not close it", () => {
  assert.deepEqual(splitMarkdownChunks("````md\n```\n\nstill inside\n````\n\nnext"), {
    stable: ["````md\n```\n\nstill inside\n````"],
    open: "next",
  });
});

test("a tilde fence is closed only by a tilde fence", () => {
  assert.deepEqual(splitMarkdownChunks("~~~\n```\n\nbody\n~~~\n\nend"), {
    stable: ["~~~\n```\n\nbody\n~~~"],
    open: "end",
  });
});

test("an indented fence inside a list item still protects its blank lines", () => {
  assert.deepEqual(splitMarkdownChunks("- item\n\n    ```\n    code\n\n    more\n    ```\n\ntail"), {
    stable: ["- item", "    ```\n    code\n\n    more\n    ```"],
    open: "tail",
  });
});

test("runs of blank lines produce no empty stable chunks", () => {
  assert.deepEqual(splitMarkdownChunks("a\n\n\n\nb\n\n"), { stable: ["a", "b"], open: "" });
});

test("no non-blank line is lost or reordered by the split", () => {
  const text = "# Title\n\nparagraph one\nline two\n\n- a\n- b\n\n```\ncode\n\nmore\n```\n\nlast";
  const { stable, open } = splitMarkdownChunks(text);
  const joined = [...stable, open].join("\n").split("\n").filter((line) => line.trim() !== "");
  const original = text.split("\n").filter((line) => line.trim() !== "");
  assert.deepEqual(joined, original);
});
