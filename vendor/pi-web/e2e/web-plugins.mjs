import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    // 1. Visit published plugin page: /plugins/dashboard is the only declared page surface
    await page.goto(`${base}/plugins/dashboard`, { waitUntil: "load" });

    // (a) Verify page heading and descriptor title
    const heading = page.locator(".plugin-page-title");
    await heading.waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await heading.textContent(), "Delegated work graph");

    // (b) Verify status marker: seeded session (__test_session__) reports running (Phase 7)
    const dashboardStatusDot = page.locator(".plugin-status-dot.plugin-status-running");
    await dashboardStatusDot.first().waitFor({ state: "visible", timeout: 30_000 });
    assert.ok(await dashboardStatusDot.first().isVisible(), "Status dot renders for running seeded session");

    // (c) Verify unpublished view shows empty state
    await page.goto(`${base}/plugins/dashboard?session=empty_session_id`, {
      waitUntil: "load",
    });

    const emptyState = page.locator(".plugin-empty-state");
    await emptyState.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(
      (await emptyState.textContent()) || "",
      /No view published yet/i,
      "Unpublished session view must show the empty state",
    );

    // Return to /plugins/dashboard for action execution and navigation verification
    await page.goto(`${base}/plugins/dashboard`, { waitUntil: "load" });
    await heading.waitFor({ state: "visible", timeout: 60_000 });

    // (d) Navigation links: verify Home link points to /
    const homeLink = page.locator(".plugin-nav-home-link");
    await homeLink.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await homeLink.getAttribute("href"), "/", "Home link points to /");

    // (e) Action confirmation, execution flow (AC5), and Realtime SSE push update without reload (Phase 7)
    // Setup client-side EventSource listener and document navigation counter in page context
    await page.evaluate(() => {
      window.__sseEvents = [];
      window.__initialNavCount = performance.getEntriesByType("navigation").length;
      const es = new EventSource("/api/plugins/events");
      es.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.type === "changed") {
            window.__sseEvents.push(parsed);
          }
        } catch {}
      };
      window.__testEs = es;
    });

    // Wait for initial connection event (revision: N)
    await page.waitForFunction(
      () => Boolean(window.__sseEvents && window.__sseEvents.length >= 1),
      null,
      { timeout: 15_000 },
    );

    const actionButton = page.locator(".plugin-action-button").filter({ hasText: "Request fresh snapshot" });
    await actionButton.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await actionButton.isDisabled(), true, "Button must be disabled before confirmation");

    const actionInput = page.locator(".plugin-action-input");
    await actionInput.waitFor({ state: "visible", timeout: 30_000 });

    // Fill exact confirm string and submit
    await actionInput.fill("request sync");
    assert.equal(await actionButton.isEnabled(), true, "Button must be enabled when confirm string matches");

    await actionButton.click();

    // Verify feedback with accepted requestId surfaces in UI
    const feedback = page.locator(".plugin-action-feedback.feedback-success");
    await feedback.waitFor({ state: "visible", timeout: 30_000 });
    const feedbackText = await feedback.textContent();
    const reqMatch = (feedbackText || "").match(/request ID: ([0-9a-f-]{36})/i);
    assert.ok(reqMatch, "Accepted requestId must surface in UI feedback message");
    const acceptedRequestId = reqMatch[1];

    // Wait for subsequent SSE "changed" event triggered by the server-side view publish
    await page.waitForFunction(
      () => Boolean(window.__sseEvents && window.__sseEvents.length >= 2),
      null,
      { timeout: 15_000 },
    );

    // Verify that the view updated to "Synchronized" via realtime SSE push without a manual reload
    const syncRow = page.locator(".plugin-kv-value").filter({ hasText: "Synchronized" });
    await syncRow.waitFor({ state: "visible", timeout: 30_000 });
    assert.ok(await syncRow.isVisible(), "View content updated to Synchronized via realtime SSE");

    // Verify the view contains the exact accepted requestId published by the server
    const reqRow = page.locator(".plugin-kv-value").filter({ hasText: acceptedRequestId });
    await reqRow.waitFor({ state: "visible", timeout: 30_000 });
    assert.ok(await reqRow.isVisible(), "View contains exact accepted requestId pushed over SSE");

    const realtimeProof = await page.evaluate(() => {
      window.__testEs?.close();
      const events = window.__sseEvents ?? [];
      return {
        navCount: performance.getEntriesByType("navigation").length,
        initialNavCount: window.__initialNavCount,
        events,
      };
    });
    assert.equal(realtimeProof.navCount, realtimeProof.initialNavCount, "Realtime update occurred without a page reload");
    assert.ok(realtimeProof.events.length >= 2, "EventSource received both initial and change events");
    assert.ok(
      realtimeProof.events[1].revision > realtimeProof.events[0].revision,
      `New revision (${realtimeProof.events[1].revision}) must exceed initial (${realtimeProof.events[0].revision})`,
    );

    // Verify dialog was never fired
    assert.equal(dialogFired, false, "Plugin action must execute without opening any dialog (AC5)");

    // (f) Every registered plugin descriptor check
    const registry = await (await fetch(`${base}/api/plugins`)).json();
    const pageSurfaces = registry.plugins.flatMap((plugin) =>
      plugin.surfaces
        .filter((surface) => surface.kind === "page")
        .map((surface) => ({ plugin, path: surface.path })),
    );
    const registeredIds = registry.plugins.map((plugin) => plugin.id);
    for (const id of ["cache-stats", "todo", "artifacts", "subagent-checkpoints", "dashboard", "bubbly-spinner"]) {
      assert.ok(registeredIds.includes(id), `Plugin "${id}" must be registered, got: ${registeredIds.join(", ")}`);
    }
    assert.ok(pageSurfaces.length >= 1, `At least one plugin must expose a page surface, got ${pageSurfaces.length}`);
    for (const { plugin, path } of pageSurfaces) {
      await page.goto(`${base}${path}`, { waitUntil: "load" });
      const title = page.locator(".plugin-page-title");
      await title.waitFor({ state: "visible", timeout: 60_000 });
      assert.equal((await title.textContent())?.trim(), plugin.title, `${path} must show its descriptor title`);
      const body = page.locator(".plugin-empty-state, .plugin-kv-table, .plugin-list, .plugin-status-badge");
      await body.first().waitFor({ state: "visible", timeout: 30_000 });
    }
    assert.equal(dialogFired, false, "No plugin page may open a dialog");

    // 2. Visit home page ("/") and verify slot surfaces (Phase 6)
    await page.goto(`${base}/`, { waitUntil: "load" });

    // (a) Top slot strip: shows Todo title and content
    const topSlot = page.locator(".plugin-slot-top");
    await topSlot.waitFor({ state: "visible", timeout: 60_000 });
    const topRunningDot = topSlot.locator(".plugin-status-dot.plugin-status-running");
    await topRunningDot.first().waitFor({ state: "visible", timeout: 30_000 });
    assert.ok(await topRunningDot.first().isVisible(), "Status dot renders for running session in top slot region");

    const topTitle = topSlot.locator(".plugin-slot-title");
    await topTitle.filter({ hasText: "Todo" }).waitFor({ state: "visible", timeout: 30_000 });
    const topContent = topSlot.locator(".plugin-slot-content");
    await topContent.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await topContent.textContent() || "", /Implement frontend slots/i, "Top slot shows todo list content");

    // Top slot strips carry no plugin-specific branches (PRD AC3): Bubbly's
    // working message reaches the browser through the unified ui snapshot.
    const working = registry.ui?.sessions?.__test_session__?.working;
    assert.ok(working, "Unified ui snapshot must be published beside legacy views");
    assert.match(String(working.message), /Ratiocinating/i, "Working message state flows through the unified ui snapshot");
    assert.equal(typeof working.visible, "boolean");
    assert.ok(working.frames === null || Array.isArray(working.frames), "frames default to the builtin spinner until an extension sets an indicator");
    assert.ok(registry.ui.epoch, "ui snapshot carries an epoch for replay recovery");

    // Left sidebar: shows green running marker dot next to running session row (Phase 8)
    const sidebarRunningRow = page.locator(".session-tree-session").filter({ has: page.locator(".plugin-status-dot.plugin-status-running") });
    await sidebarRunningRow.first().waitFor({ state: "visible", timeout: 30_000 });
    assert.ok(await sidebarRunningRow.first().isVisible(), "Sidebar row shows running status marker dot");

    // (b) Bottom slot strip: shows Cache health title and content + literal text rendering & zero script execution (AC6)
    const bottomSlot = page.locator(".plugin-slot-bottom");
    await bottomSlot.waitFor({ state: "visible", timeout: 60_000 });
    const bottomTitle = bottomSlot.locator(".plugin-slot-title");
    await bottomTitle.filter({ hasText: "Cache health" }).waitFor({ state: "visible", timeout: 30_000 });
    const bottomContent = bottomSlot.locator(".plugin-slot-content");
    await bottomContent.waitFor({ state: "visible", timeout: 30_000 });
    const bottomText = (await bottomContent.textContent()) || "";
    assert.match(bottomText, /XSS Test/i, "Bottom slot shows cache stats content");
    assert.match(bottomText, /<script>alert\('xss'\)<\/script>/, "Cell must render exact script text as a plain text node");

    // Double-check no executable <script> element contains the payload
    const scriptTagContents = await page.locator("script").allTextContents();
    assert.ok(
      !scriptTagContents.some((content) => content.includes("alert('xss')")),
      "XSS payload must never reach the DOM as an executable script element",
    );

    // (c) Center slot: collapsible panel showing Delegated work
    const centerSlot = page.locator(".plugin-slot-center");
    await centerSlot.waitFor({ state: "visible", timeout: 60_000 });
    const centerHeader = centerSlot.locator(".plugin-slot-center-header");
    await centerHeader.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await centerHeader.textContent() || "", /Delegated work/i, "Center slot shows delegated work header");

    // Verify center is collapsed by default (body hidden/absent)
    const centerBody = centerSlot.locator(".plugin-slot-center-body");
    assert.equal(await centerBody.isVisible(), false, "Center slot must be collapsed by default");

    // Expand center on click
    await centerHeader.click();
    await centerBody.waitFor({ state: "visible", timeout: 30_000 });
    assert.ok(await centerBody.isVisible(), "Center slot expands on header click");
    assert.match(await centerBody.textContent() || "", /worker-slots/i, "Center slot body renders subagent view");

    // Collapse center on click again
    await centerHeader.click();
    await centerBody.waitFor({ state: "hidden", timeout: 30_000 });
    assert.equal(await centerBody.isVisible(), false, "Center slot collapses on second click");

    // (d) Floating slot: collapsible corner widget showing Artifacts
    const floatingSlot = page.locator(".plugin-slot-floating");
    await floatingSlot.waitFor({ state: "visible", timeout: 60_000 });

    // Collapsed to a small chip by default
    const floatingChip = floatingSlot.locator(".plugin-slot-floating-chip");
    await floatingChip.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await floatingChip.textContent() || "", /Artifacts/i, "Floating slot chip shows Artifacts title");

    const floatingCard = floatingSlot.locator(".plugin-slot-floating-card");
    assert.equal(await floatingCard.isVisible(), false, "Floating slot card is not visible when collapsed");

    // Expand floating widget on click
    await floatingChip.click();
    await floatingCard.waitFor({ state: "visible", timeout: 30_000 });
    assert.ok(await floatingCard.isVisible(), "Floating card expands on chip click");
    const floatingBody = floatingSlot.locator(".plugin-slot-floating-body");
    await floatingBody.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await floatingBody.textContent() || "", /prd-phase-6\.md/i, "Floating card body renders artifacts view");

    // Collapse floating widget on close button click
    const floatingClose = floatingSlot.locator(".plugin-slot-floating-close");
    await floatingClose.click();
    await floatingChip.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await floatingCard.isVisible(), false, "Floating slot collapses back to chip on close");

    // Verify no dialog fired throughout the home page slot interactions
    assert.equal(dialogFired, false, "No dialog may fire during slot rendering and interaction");
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
  writeFileSync(
    join(agentDir, "sessions", "test", "2026-11-05T00-00-00-000Z___test_session__.jsonl"),
    `{"type":"session","id":"__test_session__","timestamp":"2026-11-05T00:00:00.000Z","cwd":"${workspace}"}\n` +
    `{"type":"message","id":"m1","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"Test session for web plugins"}]}}\n`,
  );

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

    // Prewarm in the browser before the assertions run. Next dev compiles a route
    // on first request; navigating straight into that compile makes the page
    // reload mid-compile, and the run then fails on a title that never settles.
    // Visiting every route once, without asserting, absorbs that first compile.
    const warmRegistry = await (await fetch(`${base}/api/plugins`)).json();
    const warmPaths = new Set(["/"]);
    for (const plugin of warmRegistry.plugins ?? []) {
      for (const surface of plugin.surfaces ?? []) {
        if (surface.kind === "page" && surface.path) warmPaths.add(surface.path);
      }
    }
    for (const path of warmPaths) {
      try {
        await page.goto(`${base}${path}`, { waitUntil: "load", timeout: 120_000 });
      } catch {
        // Warm-up only: a slow first compile here must not fail the run.
      }
    }
    console.log(`[web-plugins e2e] Prewarmed ${warmPaths.size} route(s).`);

    console.log("[web-plugins e2e] Running plugin view checks...");
    await checkWebPlugins(page, base);
    console.log("[web-plugins e2e] All checks passed successfully!");
  } finally {
    server.kill("SIGTERM");
    await browser?.close().catch(() => {});
  }
}
