import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

/**
 * Playwright assertions for workflow web plugins.
 *
 * @param {import("playwright").Page} page
 * @param {string} base - http://127.0.0.1:<port>
 */
export async function checkWebPlugins(page, base) {
  let dialogFired = false;
  const onDialog = (dialog) => {
    dialogFired = true;
    void dialog.dismiss().catch(() => {});
  };
  page.on("dialog", onDialog);

  try {
    // 1. Visit published plugin page (seeded via PI_WEB_TEST_PLUGIN_VIEWS=1)
    await page.goto(`${base}/plugins/cache-stats`, { waitUntil: "networkidle" });

    // (a) Verify page and published KV view
    const heading = page.locator(".plugin-page-title");
    await heading.waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await heading.textContent(), "Cache health");

    const kvTable = page.locator(".plugin-kv-table");
    await kvTable.waitFor({ state: "visible", timeout: 10_000 });

    // (b) Verify literal text rendering and zero script execution (AC6)
    const xssValue = page.locator(".plugin-kv-value").filter({ hasText: "<script>" });
    await xssValue.waitFor({ state: "visible", timeout: 5_000 });
    assert.equal(await xssValue.count(), 1, "Exactly one cell with script tag text exists");

    const textContent = await xssValue.textContent();
    assert.equal(
      textContent?.trim(),
      "<script>alert('xss')</script>",
      "Cell must render exact script text as a plain text node",
    );

    // Verify dialog was NOT triggered
    assert.equal(dialogFired, false, "Script string must not execute or open a dialog");

    // Double-check no executable <script> element contains the payload
    const scriptTagContents = await page.locator("script").allTextContents();
    assert.ok(
      !scriptTagContents.some((content) => content.includes("alert('xss')")),
      "XSS payload must never reach the DOM as an executable script element",
    );

    // (c) Verify unpublished view shows empty state
    await page.goto(`${base}/plugins/cache-stats?session=empty_session_id`, {
      waitUntil: "networkidle",
    });

    const emptyState = page.locator(".plugin-empty-state");
    await emptyState.waitFor({ state: "visible", timeout: 10_000 });
    assert.match(
      (await emptyState.textContent()) || "",
      /No view published yet/i,
      "Unpublished session view must show the empty state",
    );

    // Verify navigation links
    const homeLink = page.locator(".plugin-nav-home-link");
    assert.ok(await homeLink.isVisible(), "Home link is visible on plugin page");
    assert.equal(await homeLink.getAttribute("href"), "/", "Home link points to /");
  } finally {
    page.off("dialog", onDialog);
  }
}

// Standalone execution runner when run directly as `node e2e/web-plugins.mjs`
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  assert.ok(
    !existsSync(join(root, ".next/dev/lock")),
    "Run in a checkout without an active dev server",
  );

  const artifacts = mkdtempSync(join(tmpdir(), "pi-web-plugins-e2e-"));
  console.log(`[web-plugins e2e] Artifacts: ${artifacts}`);
  const agentDir = join(artifacts, "agent");
  const workspace = join(artifacts, "workspace");
  mkdirSync(join(agentDir, "sessions", "test"), { recursive: true });
  mkdirSync(workspace);

  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const base = `http://127.0.0.1:${port}`;
  const log = createWriteStream(join(artifacts, "server.log"));

  console.log(`[web-plugins e2e] Starting Next dev server on ${base}...`);
  const server = spawn(
    process.execPath,
    [join(root, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(port)],
    {
      cwd: root,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_WEB_PASSWORD: "",
        PI_WEB_TEST_PLUGIN_VIEWS: "1",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  server.stdout.pipe(log, { end: false });
  server.stderr.pipe(log, { end: false });

  let browser;
  try {
    for (let i = 0; ; i++) {
      const response = await fetch(`${base}/api/plugins`).catch(() => null);
      if (response?.ok) break;
      assert.ok(i < 120 && server.exitCode === null, "Server did not become ready");
      await delay(500);
    }
    console.log("[web-plugins e2e] Server ready. Launching chromium...");
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    console.log("[web-plugins e2e] Running plugin view checks...");
    await checkWebPlugins(page, base);
    console.log("[web-plugins e2e] All checks passed successfully!");
  } finally {
    server.kill("SIGTERM");
    await browser?.close().catch(() => {});
  }
}
