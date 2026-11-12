// Focused e2e for the Files panel viewers: PDF, image, text, markdown, CSV,
// and the office/binary download fallbacks. Boots the standalone server with
// the fixture session rooted at a throwaway directory of known files, then
// drives the Files panel through a real browser and asserts each viewer
// renders (or degrades to the documented download fallback) without a crash.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
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

/** A valid RGB PNG: signature + IHDR + deflate'd raw scanlines + IEND. */
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

function makePng(width, height, rgb) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const offset = y * stride + 1 + x * 3;
      raw[offset] = rgb[0];
      raw[offset + 1] = rgb[1];
      raw[offset + 2] = rgb[2];
    }
  }
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

/** A minimal one-page PDF with a correct xref table, built without a library. */
function makePdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const content = "BT /F1 24 Tf 50 240 Td (PDF Viewer e2e) Tj ET";
  objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

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

async function writeFixtures() {
  await writeFile(join(fixtureDir, "README.md"), "# Viewer E2E\n\n- alpha\n- beta\n");
  await writeFile(join(fixtureDir, "hello.txt"), "hello from the text viewer\nsecond line\n");
  await writeFile(join(fixtureDir, "data.csv"), "name,count\nalpha,1\nbeta,2\n");
  await writeFile(join(fixtureDir, "pixel.png"), makePng(12, 12, [200, 40, 40]));
  await writeFile(join(fixtureDir, "sample.pdf"), makePdf());
  await writeFile(join(fixtureDir, "report.docx"), "fake docx payload");
  await writeFile(join(fixtureDir, "spreadsheet.xlsx"), "fake xlsx payload");
  await writeFile(join(fixtureDir, "slide.pptx"), "fake pptx payload");
  await writeFile(join(fixtureDir, "mystery.xyz"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
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

async function run() {
  const server = spawn("npx", ["tsx", "core/server/main.ts"], {
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

    step("pdf viewer renders a page canvas");
    await openFile(page, "sample.pdf");
    await assertKind(page, "PDF");
    await page.locator(".files-pdf-page").first().waitFor({ state: "visible", timeout: 15_000 });
    assert.ok((await page.locator(".files-pdf-page").count()) >= 1, "pdf.js renders at least one page");
    const canvasWidth = await page.locator(".files-pdf-page").first().evaluate((el) => el.width);
    assert.ok(canvasWidth > 0, `the rendered page has pixels (width ${canvasWidth})`);
    await backToFiles(page);

    step("docx viewer falls back to the documented download prompt");
    await openFile(page, "report.docx");
    await assertKind(page, "Document");
    await assertPreviewBodyContains(page, "Preview unavailable for this file type.");
    await assertPreviewBodyContains(page, "Document files open in their desktop app");
    const docxHref = await page.locator(".files-unsupported a.files-action").getAttribute("href");
    assert.ok(docxHref?.includes("report.docx") && docxHref.includes("download=1"), "the download link targets the file as an attachment");
    await backToFiles(page);

    step("xlsx viewer falls back to the documented download prompt");
    await openFile(page, "spreadsheet.xlsx");
    await assertKind(page, "Spreadsheet");
    await assertPreviewBodyContains(page, "Spreadsheet files open in their desktop app");
    await backToFiles(page);

    step("pptx viewer falls back to the documented download prompt");
    await openFile(page, "slide.pptx");
    await assertKind(page, "Presentation");
    await assertPreviewBodyContains(page, "Presentation files open in their desktop app");
    await backToFiles(page);

    step("unknown binary degrades to the generic fallback with no crash");
    await openFile(page, "mystery.xyz");
    await assertKind(page, "Binary");
    await assertPreviewBodyContains(page, "Preview unavailable for this file type.");
    const binaryBody = (await page.locator(".files-preview-body").textContent()) ?? "";
    assert.ok(!binaryBody.includes("open in their desktop app"), "the generic fallback carries no desktop-app note");

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