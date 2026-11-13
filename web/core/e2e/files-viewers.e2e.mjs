// Focused e2e for the Files panel viewers: PDF, Word, Excel, PowerPoint via
// Flyfish File Viewer; image, text, markdown, CSV via the native previews;
// unknown binary via the download fallback. Boots the standalone server with
// the fixture session rooted at a throwaway directory of known files, then
// drives the Files panel through a real browser and asserts each viewer
// renders (or degrades to the documented download fallback) without a crash.
//
// The document viewer renders in shadow DOM; Playwright locators pierce open
// shadow roots, so text/canvas assertions work across the boundary.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDocx, makePdf, makePng, makePptx, makeXlsx } from "./viewer-fixtures.mjs";
import assert from "node:assert/strict";

const PORT = 30_000 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
// Isolated plugin state per run (see e2e.mjs for why: the crash-loop guard
// would otherwise count test starts against the real ~/.pi/agent state).
const pluginStateDir = await mkdtemp(join(tmpdir(), "pi-web-viewers-e2e-"));
const PLUGIN_STATE = join(pluginStateDir, "plugins.json");
const fixtureDir = await mkdtemp(join(tmpdir(), "pi-web-viewers-files-"));

/** Step marker: pins where a stall happens. */
const step = (name) => console.log(`[viewers-e2e] ${name}`);

async function writeFixtures() {
  await writeFile(join(fixtureDir, "README.md"), "# Viewer E2E\n\n- alpha\n- beta\n");
  await writeFile(join(fixtureDir, "hello.txt"), "hello from the text viewer\nsecond line\n");
  await writeFile(join(fixtureDir, "data.csv"), "name,count\nalpha,1\nbeta,2\n");
  await writeFile(join(fixtureDir, "pixel.png"), makePng(12, 12, [200, 40, 40]));
  await writeFile(join(fixtureDir, "sample.pdf"), makePdf());
  await writeFile(join(fixtureDir, "report.docx"), makeDocx());
  await writeFile(join(fixtureDir, "spreadsheet.xlsx"), makeXlsx());
  await writeFile(join(fixtureDir, "slide.pptx"), makePptx());
  await writeFile(join(fixtureDir, "mystery.xyz"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
}

// ── Harness ────────────────────────────────────────────────────────────────

async function waitForHealth(baseUrl, timeoutMs = 30_000, serverExitCode = () => null, logs = []) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exitCode = serverExitCode();
    if (exitCode !== null) {
      throw new Error(`server exited during startup (code ${exitCode})\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become healthy\n${logs.join("")}`);
}

async function selectFixtureSession(page) {
  await page.click('.app-session-item[data-id="__test_session__"]');
  await page.locator('.app-session-item[data-id="__test_session__"].is-selected').waitFor({ timeout: 15_000 });
}

async function openFilesPanel(page) {
  await page.getByRole("button", { name: "More panels", exact: true }).click();
  // Files is the last enabled menu entry. Keyboard navigation avoids the
  // Radix submenu's pointer-leave close, which makes a mouse click on the
  // submenu's "Open panel" item flaky (the menu detaches mid-click).
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await page.getByRole("complementary", { name: "Files panel" }).waitFor({ timeout: 10_000 });
  await page.getByTestId("files-browser").waitFor({ state: "visible", timeout: 10_000 });
}

async function openFile(page, name) {
  await page.getByRole("button", { name, exact: true }).click();
  await page.getByTestId("files-preview").waitFor({ state: "visible", timeout: 10_000 });
}

async function backToFiles(page) {
  await page.getByRole("button", { name: "Back to files" }).click();
  await page.getByTestId("files-browser").waitFor({ state: "visible", timeout: 10_000 });
}

async function assertKind(page, label) {
  assert.equal((await page.locator(".files-preview-kind").textContent())?.trim(), label);
}

async function assertPreviewBodyContains(page, text) {
  await page.waitForFunction(
    (needle) => (document.querySelector(".files-preview-body")?.textContent ?? "").includes(needle),
    text,
    { timeout: 10_000 },
  );
}

/** Wait for a document-viewer render signal that is not the loading spinner. */
async function assertDocumentRenders(page) {
  await page.getByTestId("files-document").waitFor({ state: "visible", timeout: 10_000 });
  await page.locator(".files-document-view").first().waitFor({ state: "visible", timeout: 10_000 });
}

async function assertFullScreenFiles(page) {
  const panel = page.getByRole("complementary", { name: "Files panel" });
  const docked = await panel.boundingBox();
  const search = page.getByRole("searchbox", { name: "Search filenames" });
  await search.fill("README");
  await page.getByRole("button", { name: "README.md", exact: true }).waitFor();
  await page.getByRole("button", { name: "Expand file explorer", exact: true }).click();
  assert.equal(await search.inputValue(), "README", "expanding preserves the explorer's search state");
  await assertPanelFillsViewport(page);
  await page.getByRole("button", { name: "Exit full screen", exact: true }).click();
  assert.ok(Math.abs((await panel.boundingBox()).width - docked.width) < 1, "restore returns to the same docked width");
  await search.fill("");
  await openFile(page, "README.md");
  await page.getByRole("button", { name: "Expand file preview", exact: true }).click();
  await assertPanelFillsViewport(page);
  await page.locator(".files-markdown-rendered h1").waitFor();
  await page.keyboard.press("Escape");
  await page.getByTestId("files-preview").waitFor();
  await page.getByRole("button", { name: "Expand file preview", exact: true }).waitFor();
  assert.ok(Math.abs((await panel.boundingBox()).width - docked.width) < 1, "Escape restores the preview without closing it");
  await backToFiles(page);
}

async function assertPanelFillsViewport(page) {
  const viewport = page.viewportSize();
  // resize/visualViewport events are delivered after setViewportSize resolves.
  await page.waitForFunction(({ width, height }) => {
    const box = document.querySelector('.files-panel.is-fullscreen')?.getBoundingClientRect();
    return box !== undefined && Math.abs(box.width - width) < 1 && Math.abs(box.height - height) < 1;
  }, viewport);
  const box = await page.getByRole("complementary", { name: "Files panel" }).boundingBox();
  assert.ok(Math.abs(box.x) < 1 && Math.abs(box.y) < 1, "full-screen Files starts at the viewport origin");
  assert.ok(Math.abs(box.width - viewport.width) < 1 && Math.abs(box.height - viewport.height) < 1, "Files fills the available viewport, not its narrow panel slot");
}

async function assertPhoneFiles(page) {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.getByRole("button", { name: "More panels", exact: true }).click();
  await page.getByRole("menuitem", { name: "Files", exact: true }).click();
  await page.getByTestId("files-browser").waitFor();
  await assertPanelFillsViewport(page);
  assert.ok(await page.getByRole("searchbox", { name: "Search filenames" }).evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 16), "phone file search avoids focus zoom");
  await openFile(page, "README.md");
  await page.locator(".files-markdown-rendered h1").waitFor();
  await page.getByRole("button", { name: "Exit full screen", exact: true }).click();
  await page.getByRole("button", { name: "Expand file preview", exact: true }).click();
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 360 }, { width: 720, height: 600 }]) {
    await page.setViewportSize(viewport);
    await assertPanelFillsViewport(page);
  }
  await backToFiles(page);
  await assertPanelFillsViewport(page);
  await page.keyboard.press("Escape");
  await page.getByTestId("files-browser").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("complementary", { name: "Files panel" }).count(), 0, "Escape closes the restored phone explorer");
}

async function run() {
  const server = spawn("npx", ["tsx", "server.ts"], {
    cwd: new URL("../..", import.meta.url).pathname,
    env: {
      ...process.env,
      PI_WEB_PORT: String(PORT),
      PI_WEB_PLUGIN_STATE: PLUGIN_STATE,
      PI_WEB_TEST_PLUGIN_VIEWS: "1",
      PI_WEB_TEST_FILES_ROOT: fixtureDir,
      PI_WEB_AUTH_FILE: join(pluginStateDir, "web-auth.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const logs = [];
  server.stdout.on("data", (chunk) => logs.push(String(chunk)));
  server.stderr.on("data", (chunk) => logs.push(String(chunk)));
  let serverExitCode = null;
  server.once("exit", (code) => {
    serverExitCode = code ?? -1;
  });

  let passed = false;
  let browser;
  try {
    await writeFixtures();
    await waitForHealth(BASE, 30_000, () => serverExitCode, logs);
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));

    await page.goto(`${BASE}/`);
    await page.waitForSelector(".app-shell", { timeout: 20_000 });
    await selectFixtureSession(page);
    await openFilesPanel(page);
    step("full-screen explorer and preview preserve state and restore the docked panel");
    await assertFullScreenFiles(page);

    step("markdown viewer renders and toggles to source");
    await openFile(page, "README.md");
    await assertKind(page, "Markdown");
    await page.locator(".files-markdown-rendered h1").waitFor({ state: "visible", timeout: 10_000 });
    assert.equal((await page.locator(".files-markdown-rendered h1").textContent())?.trim(), "Viewer E2E");
    assert.ok((await page.locator(".files-markdown-rendered li").count()) >= 2, "markdown list items render");
    await page.getByRole("button", { name: "Source", exact: true }).click();
    await assertPreviewBodyContains(page, "# Viewer E2E");
    await backToFiles(page);

    step("text viewer renders source in the editor");
    await openFile(page, "hello.txt");
    await assertKind(page, "Source");
    await assertPreviewBodyContains(page, "hello from the text viewer");
    await backToFiles(page);

    step("csv viewer renders the delimited text");
    await openFile(page, "data.csv");
    await assertKind(page, "CSV");
    await assertPreviewBodyContains(page, "alpha,1");
    await backToFiles(page);

    step("image viewer decodes the streamed bytes");
    await openFile(page, "pixel.png");
    await assertKind(page, "Image");
    await page.waitForFunction(
      () => {
        const img = document.querySelector(".files-image img");
        return img !== null && img.naturalWidth > 0;
      },
      undefined,
      { timeout: 10_000 },
    );
    await backToFiles(page);

    step("pdf viewer renders the page (canvas) via File Viewer");
    await openFile(page, "sample.pdf");
    await assertKind(page, "PDF");
    await assertDocumentRenders(page);
    // pdf.js draws each page into a canvas; the text layer carries the words.
    await page.locator(".files-document-view canvas").first().waitFor({ state: "visible", timeout: 20_000 });
    await page.getByText("PDF Viewer e2e").first().waitFor({ state: "attached", timeout: 20_000 });
    // PDF.js may replace canvases when fitting a new width; the viewer's
    // toolbar must survive so maximize/restore doesn't recreate the document.
    const pdfToolbar = await page.locator(".files-document-view .pdf-toolbar").first().elementHandle();
    await page.getByRole("button", { name: "Expand file preview", exact: true }).click();
    await assertPanelFillsViewport(page);
    assert.ok(await pdfToolbar.evaluate(el => el.isConnected), "maximizing does not remount the loaded PDF viewer");
    await page.getByRole("button", { name: "Exit full screen", exact: true }).click();
    assert.ok(await pdfToolbar.evaluate(el => el.isConnected), "restoring keeps the same loaded PDF viewer");
    await backToFiles(page);

    step("docx viewer renders the document text via File Viewer");
    await openFile(page, "report.docx");
    await assertKind(page, "Document");
    await assertDocumentRenders(page);
    await page.getByText("Hello docx").first().waitFor({ state: "visible", timeout: 20_000 });
    await backToFiles(page);

    step("xlsx viewer renders the sheet grid via File Viewer");
    await openFile(page, "spreadsheet.xlsx");
    await assertKind(page, "Spreadsheet");
    await assertDocumentRenders(page);
    // The visible sheet tab is a button; a hidden "Preparing …" placeholder
    // carries the same title, so match the tab itself.
    await page.getByRole("button", { name: "Sheet1", exact: true }).first().waitFor({ state: "visible", timeout: 20_000 });
    await page.getByText(/2 rows, 1 columns/).first().waitFor({ state: "visible", timeout: 20_000 });
    await backToFiles(page);

    step("pptx viewer renders the slide via File Viewer");
    await openFile(page, "slide.pptx");
    await assertKind(page, "Presentation");
    await assertDocumentRenders(page);
    await page.getByText("Hello pptx").first().waitFor({ state: "visible", timeout: 20_000 });
    await backToFiles(page);

    step("unknown binary degrades to the generic fallback with no crash");
    await openFile(page, "mystery.xyz");
    await assertKind(page, "Binary");
    await assertPreviewBodyContains(page, "Preview unavailable for this file type.");
    await backToFiles(page);
    step("phone explorer and previews use the full viewport with restore controls");
    await assertPhoneFiles(page);

    assert.deepEqual(pageErrors, [], "the browser must stay error-free across every viewer");

    await browser.close();
    passed = true;
    console.log("[viewers-e2e] all checks passed");
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (serverExitCode === null) {
      killServerGroup("SIGTERM");
      await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]).catch(() => {});
      if (serverExitCode === null) killServerGroup("SIGKILL");
      await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]).catch(() => {});
    }
    await rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
    await rm(pluginStateDir, { recursive: true, force: true }).catch(() => {});
    if (!passed && logs.length > 0) {
      console.error(logs.join(""));
    }
  }

  function killServerGroup(signal) {
    try {
      process.kill(-server.pid, signal);
    } catch {
      try {
        server.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }
}

run().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
