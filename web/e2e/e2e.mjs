// End-to-end suite for the minimal pi-web client. Drives the standalone
// server with the fixture session (PI_WEB_TEST_PLUGIN_VIEWS=1) through a
// real browser: the base shell, session selection, plugin slots, the
// composer region override, plugin pages, the confirmed-action round trip
// (realtime view update without reload) and the instant-action shortcut.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";

const PORT = 30_000 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForHealth(baseUrl, timeoutMs = 30_000, serverExitCode = () => null, logs = []) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Fail fast when the server dies at startup: its logs are the only
    // diagnostic, and waiting out the timeout would only hide them.
    const exitCode = serverExitCode();
    if (exitCode !== null) {
      throw new Error(`server exited during startup (code ${exitCode})\n${logs.join("")}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become healthy\n${logs.join("")}`);
}

async function selectFixtureSession(page) {
  await page.selectOption(".app-session-select", "__test_session__");
  // The composer override only renders once the session's plugin views land.
  await page.waitForSelector('[data-region-override="composer"]', { timeout: 15_000 });
}

async function run() {
  // Detached: the server runs in its own process group so the teardown can
  // kill the whole tree (npx → tsx → node). A SIGTERM to the npx wrapper
  // alone leaves the node grandchild alive holding the stdio pipes, and the
  // runner then never exits.
  const server = spawn("npx", ["tsx", "server/main.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      PI_WEB_PORT: String(PORT),
      PI_WEB_TEST_PLUGIN_VIEWS: "1",
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
    await waitForHealth(BASE, 30_000, () => serverExitCode, logs);
    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));

    // 1. Base shell: header, session picker, disabled composer.
    await page.goto(`${BASE}/`);
    await page.waitForSelector(".app-shell", { timeout: 20_000 });
    assert.equal(await page.locator(".app-title").textContent(), "pi");
    const composer = page.locator(".app-composer-input");
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    assert.ok(await composer.isDisabled(), "composer is disabled without a session");

    // The fixture session is listed as live.
    await page.waitForFunction(
      () => {
        const select = document.querySelector(".app-session-select");
        return select !== null && [...select.options].some((option) => option.value === "__test_session__");
      },
      undefined,
      { timeout: 15_000 },
    );

    // 2. Select the fixture session: slots render from the seeded views.
    await selectFixtureSession(page);

    const topSlot = page.locator(".plugin-slot-top");
    await topSlot.waitFor({ state: "visible", timeout: 15_000 });
    assert.ok(
      (await topSlot.textContent())?.includes("Implement frontend slots"),
      "top slot shows the todo fixture summary",
    );

    const bottomSlot = page.locator(".plugin-slot-bottom");
    await bottomSlot.waitFor({ state: "visible", timeout: 15_000 });
    assert.ok(
      (await bottomSlot.textContent())?.includes("XSS Test"),
      "bottom slot shows the cache fixture summary",
    );

    const centerSlot = page.locator(".plugin-slot-center");
    await centerSlot.waitFor({ state: "visible", timeout: 15_000 });
    assert.ok(
      (await centerSlot.textContent())?.includes("Delegated work"),
      "center slot renders the checkpoints view",
    );

    const floatingChip = page.locator(".plugin-slot-floating-chip");
    await floatingChip.first().waitFor({ state: "visible", timeout: 15_000 });

    // 3. Region override: the composer is replaced by the example plugin's
    //    declarative view, and the built-in input is gone.
    const override = page.locator('[data-region-override="composer"]');
    await override.waitFor({ state: "visible", timeout: 15_000 });
    assert.ok(
      (await override.textContent())?.includes("Composer replaced (fixture)"),
      "the override view replaces the composer",
    );
    assert.equal(
      await page.locator(".app-composer-input").count(),
      0,
      "the built-in composer is absent while overridden",
    );

    // 4. The working indicator: the fixture session reports running and the
    //    seeded working message renders.
    const working = page.locator(".msg-working");
    await working.waitFor({ state: "visible", timeout: 15_000 });
    assert.ok((await working.textContent())?.includes("Ratiocinating"));

    // 5. Instant-action shortcut (before the confirmed action, so the
    //    in-flight guard is not involved): Alt+M fires the modes action and
    //    the toast confirms the relay.
    await page.locator(".app-title").click(); // Blur the select so the shortcut is not eaten.
    await page.keyboard.press("Alt+M");
    const toast = page.locator(".plugin-action-toast");
    await toast.waitFor({ state: "visible", timeout: 10_000 });
    assert.ok(
      (await toast.textContent())?.includes("Switch mode"),
      "the Alt+M shortcut relays the modes action",
    );

    // 6. Plugin page: the subagent monitor graph renders with expandable nodes.
    await page.goto(`${BASE}/plugins/subagent-monitor`);
    await page.waitForSelector(".plugin-view-graph", { timeout: 20_000 });
    assert.equal(await page.locator(".app-header .app-title").textContent(), "Subagent monitor");
    assert.ok(
      await page.locator(".plugin-graph-node-label", { hasText: "Fixture parent" }).first().isVisible(),
      "the graph shows the fixture parent node",
    );

    // 7. Confirmed action round trip: typing the exact confirm string relays
    //    the request; the fixture bus records it and the graph label updates
    //    with the requestId over SSE — no reload.
    const actionInput = page.locator(".plugin-action-input");
    await actionInput.fill("request sync");
    await page.locator(".plugin-action-button").click();
    const feedback = page.locator(".plugin-action-feedback.feedback-success");
    await feedback.waitFor({ state: "visible", timeout: 10_000 });
    const feedbackText = (await feedback.textContent()) ?? "";
    const requestId = feedbackText.match(/request ID: ([a-z0-9-]+)/i)?.[1];
    assert.ok(requestId, `the feedback carries a requestId (${feedbackText})`);
    const updatedNode = page.locator(".plugin-graph-node-label").filter({ hasText: requestId });
    await updatedNode.waitFor({ state: "visible", timeout: 15_000 });
    assert.ok(
      (await updatedNode.first().textContent())?.includes(requestId),
      "the accepted requestId flows into the graph label in realtime",
    );

    assert.deepEqual(pageErrors, [], "the browser must stay error-free");

    await browser.close();
    passed = true;
    console.log("[e2e] all checks passed");
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (serverExitCode === null) {
      killServerGroup("SIGTERM");
      // Bounded wait: a child that dies without emitting "exit" to a
      // listener registered this late would strand the run promise with no
      // handles left — a silent exit-0 with no diagnostics.
      await Promise.race([
        once(server, "exit"),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]).catch(() => {});
      if (serverExitCode === null) killServerGroup("SIGKILL");
      await Promise.race([
        once(server, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]).catch(() => {});
    }
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
