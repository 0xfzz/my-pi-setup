import assert from "node:assert/strict";
import { test, after } from "node:test";
import { findChromiumExecutable, getPlaywrightCore, closeSharedBrowser, readWebPage } from "../lib/web-read.ts";
import webReadExtension from "../extensions/web-read.ts";
import { PLAN_TOOLS } from "../lib/plan-mode.ts";

after(async () => {
  await closeSharedBrowser();
});

test("findChromiumExecutable finds an available chromium executable", () => {
  const execPath = findChromiumExecutable();
  assert.ok(execPath, "Should find a chromium executable path");
  assert.ok(typeof execPath === "string" && execPath.length > 0);
});

test("getPlaywrightCore loads playwright-core module", async () => {
  const pw = await getPlaywrightCore();
  assert.ok(pw, "Playwright core should be loaded");
  assert.ok(pw.chromium, "Chromium browser type should exist on playwright");
});

test("web_read is registered with readOnlyHint and included in PLAN_TOOLS", () => {
  const registeredTools: any[] = [];
  const registeredEvents: Record<string, Function> = {};

  const fakePi: any = {
    registerTool: (toolDef: any) => {
      registeredTools.push(toolDef);
    },
    on: (event: string, handler: Function) => {
      registeredEvents[event] = handler;
    },
  };

  webReadExtension(fakePi);

  assert.equal(registeredTools.length, 1);
  const tool = registeredTools[0];
  assert.equal(tool.name, "web_read");
  assert.equal(tool.label, "Web Read");
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.ok(tool.parameters);

  // Must be in PLAN_TOOLS so Plan mode allows it
  assert.ok(PLAN_TOOLS.has("web_read"), "web_read must be in PLAN_TOOLS");
  assert.ok(typeof registeredEvents["session_shutdown"] === "function");
});

test("web_read executes and extracts content from a local data URI or page", async () => {
  const registeredTools: any[] = [];
  const fakePi: any = {
    registerTool: (toolDef: any) => registeredTools.push(toolDef),
    on: () => {},
  };

  webReadExtension(fakePi);
  const tool = registeredTools[0];

  // Test with data URL containing dynamic structure
  const dataHtml = `data:text/html,<html><head><title>Test Title</title></head><body><main><h1>Hello World</h1><p>This is a paragraph with <a href="https://example.com">a link</a>.</p><ul><li>Item 1</li><li>Item 2</li></ul></main></body></html>`;

  const result = await tool.execute("call-1", { url: dataHtml, format: "markdown" });
  assert.ok(result);
  assert.ok(result.content && result.content[0]?.text);
  assert.ok(result.content[0].text.includes("Hello World"));
  assert.ok(result.content[0].text.includes("Test Title"));
  assert.ok(result.content[0].text.includes("[a link](https://example.com/"));
  assert.equal(result.details.title, "Test Title");
  assert.equal(result.details.truncated, false);

  await closeSharedBrowser();
});

test("web_read supports selector scoping and plain text format", async () => {
  const dataHtml = `data:text/html,<html><head><title>Scope Test</title></head><body><nav><p>Ignore Nav</p></nav><article id="target"><h2>Article Heading</h2><p>Article body content.</p></article><aside><p>Ignore Aside</p></aside></body></html>`;

  const result = await readWebPage({
    url: dataHtml,
    selector: "#target",
    format: "text",
  });

  assert.equal(result.title, "Scope Test");
  assert.ok(result.content.includes("Article Heading"));
  assert.ok(result.content.includes("Article body content"));
  assert.ok(!result.content.includes("Ignore Nav"));
  assert.ok(!result.content.includes("Ignore Aside"));

  await closeSharedBrowser();
});

test("web_read truncates long content when exceeding maxChars", async () => {
  const longParagraph = "<p>" + "A".repeat(500) + "</p>";
  const dataHtml = `data:text/html,<html><head><title>Long Test</title></head><body><main>${longParagraph}</main></body></html>`;

  const result = await readWebPage({
    url: dataHtml,
    maxChars: 100,
  });

  assert.equal(result.truncated, true);
  assert.ok(result.content.includes("[Content truncated: showing 100 of"));

  await closeSharedBrowser();
});

test("web_read respects abort signal cancellation", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    async () => {
      await readWebPage({
        url: "https://example.com",
        signal: controller.signal,
      });
    },
    /aborted|cancelled/i
  );
});
