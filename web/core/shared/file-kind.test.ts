import test from "node:test";
import assert from "node:assert/strict";
import { classifyFile, mimeTypeFor, TEXT_PREVIEW_MAX_BYTES } from "./file-kind.ts";

test("classifyFile assigns the closed preview categories", () => {
  assert.equal(classifyFile("a.md"), "markdown");
  assert.equal(classifyFile("a.png"), "image");
  assert.equal(classifyFile("x.pdf"), "pdf");
  assert.equal(classifyFile("x.mp3"), "audio");
  assert.equal(classifyFile("x.mp4"), "video");
  assert.equal(classifyFile("x.ts"), "text");
  assert.equal(classifyFile("README.md"), "markdown");
});

test("HTML and SVG are text (source-only), never inline active content", () => {
  assert.equal(classifyFile("index.html"), "text");
  assert.equal(classifyFile("logo.svg"), "text");
});

test("extensionless source basenames read as text; unknown extensions are binary", () => {
  assert.equal(classifyFile("Makefile"), "text");
  assert.equal(classifyFile("Dockerfile"), "text");
  assert.equal(classifyFile("LICENSE"), "text");
  assert.equal(classifyFile("mystery.xyz"), "binary");
});

test("mimeTypeFor returns an allowlisted type or null for unknown/executable", () => {
  assert.equal(mimeTypeFor("a.png"), "image/png");
  assert.equal(mimeTypeFor("a.pdf"), "application/pdf");
  assert.equal(mimeTypeFor("a.html"), "text/html; charset=utf-8");
  assert.equal(mimeTypeFor("a.svg"), "image/svg+xml");
  assert.equal(mimeTypeFor("a.xyz"), null);
});

test("office documents, spreadsheets, decks and delimited text are classified", () => {
  assert.equal(classifyFile("a.docx"), "document");
  assert.equal(classifyFile("a.doc"), "document");
  assert.equal(classifyFile("a.odt"), "document");
  assert.equal(classifyFile("a.rtf"), "document");
  assert.equal(classifyFile("a.xlsx"), "spreadsheet");
  assert.equal(classifyFile("a.xls"), "spreadsheet");
  assert.equal(classifyFile("a.xlsm"), "spreadsheet");
  assert.equal(classifyFile("a.ods"), "spreadsheet");
  assert.equal(classifyFile("a.pptx"), "presentation");
  assert.equal(classifyFile("a.ppt"), "presentation");
  assert.equal(classifyFile("a.odp"), "presentation");
  assert.equal(classifyFile("data.csv"), "csv");
  assert.equal(classifyFile("data.tsv"), "csv");
});

test("office and delimited files get an allowlisted download mime type", () => {
  assert.equal(mimeTypeFor("a.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(mimeTypeFor("a.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(mimeTypeFor("a.pptx"), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  assert.equal(mimeTypeFor("data.csv"), "text/csv; charset=utf-8");
  assert.equal(mimeTypeFor("data.tsv"), "text/tab-separated-values; charset=utf-8");
});

test("the text preview cap is the documented 2 MiB", () => {
  assert.equal(TEXT_PREVIEW_MAX_BYTES, 2 * 1024 * 1024);
});