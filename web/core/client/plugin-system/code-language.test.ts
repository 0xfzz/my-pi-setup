import assert from "node:assert/strict";
import test from "node:test";
import { codeLanguageForFilename, type CodeLanguage } from "./code-language.ts";

test("a TypeScript file resolves to the TypeScript highlighter", () => {
  assert.equal(codeLanguageForFilename("/repo/src/orch-child.ts"), "typescript");
});

test("extension aliases resolve to their closest language highlighter", () => {
  const cases: Array<[string, CodeLanguage]> = [
    ["script.mjs", "javascript"],
    ["component.jsx", "jsx"],
    ["component.tsx", "tsx"],
    ["types.mts", "typescript"],
    ["data.json", "json"],
    ["page.html", "html"],
    ["theme.css", "css"],
    ["train.py", "python"],
    ["main.rs", "rust"],
    ["pipeline.yml", "yaml"],
    ["install.sh", "shell"],
  ];
  for (const [filename, expected] of cases) {
    assert.equal(codeLanguageForFilename(filename), expected, filename);
  }
});

test("the language mapping ignores directory names and file-name case", () => {
  assert.equal(codeLanguageForFilename("C:\\repo\\src\\Editor.TS"), "typescript");
});

test("an unknown or missing file name leaves highlighting disabled", () => {
  assert.equal(codeLanguageForFilename("notes.txt"), undefined);
  assert.equal(codeLanguageForFilename("Makefile"), undefined);
  assert.equal(codeLanguageForFilename(undefined), undefined);
});
