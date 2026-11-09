// End-to-end suite for the minimal pi-web client. Drives the standalone
// server with the fixture session (PI_WEB_TEST_PLUGIN_VIEWS=1) through a
// real browser: the base shell, session selection, plugin slots, the
// composer region override, plugin pages, the confirmed-action round trip
// (realtime view update without reload) and the instant-action shortcut.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const PORT = 30_000 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
// Isolated plugin state per run: the manager's crash-loop guard otherwise
// counts every e2e server start against the real ~/.pi/agent state and a
// re-run within 60 s boots in safe mode (no plugins, failing the suite).
const pluginStateDir = await mkdtemp(join(tmpdir(), "pi-web-e2e-"));
const PLUGIN_STATE = join(pluginStateDir, "plugins.json");

/** Step marker: an e2e log that pinpoints where a stall happens. */
const step = (name) => console.log(`[e2e] ${name}`);

/**
 * Stall watchdog: if the run stops making progress while the event loop is
 * still alive, dump the pending libuv handles so the stuck await is
 * identifiable. (unref'd: it never keeps the process alive on its own.)
 */
const watchdog = setTimeout(() => {
  console.error("[e2e] WATCHDOG: stalled — active handles:");
  for (const handle of process._getActiveHandles?.() ?? []) {
    console.error("  -", handle?.constructor?.name, handle?._idleTimeout ?? "");
  }
  process.exit(2);
}, 150_000);
watchdog.unref?.();

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
  await page.click('.app-session-item[data-id="__test_session__"]');
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
      PI_WEB_PLUGIN_STATE: PLUGIN_STATE,
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

    step("1: base shell");
    // 1. Base shell: header, session picker, disabled composer.
    await page.goto(`${BASE}/`);
    await page.waitForSelector(".app-shell", { timeout: 20_000 });
    assert.equal(await page.locator(".app-title").textContent(), "pi");
    const composer = page.locator(".app-composer-input");
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    assert.ok(await composer.isDisabled(), "composer is disabled without a session");

    // The fixture session is listed as live.
    await page.waitForSelector('.app-session-item[data-id="__test_session__"]', {
      timeout: 15_000,
    });

    step("2: fixture session + slots");
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

    step("3: composer override");
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

    step("4: working indicator");
    // 4. The working indicator: the fixture session reports running and the
    //    seeded working message renders.
    const working = page.locator(".msg-working");
    await working.waitFor({ state: "visible", timeout: 15_000 });
    assert.ok((await working.textContent())?.includes("Ratiocinating"));

    step("4d: popups — toast, status chip, editor widget");
    // 4d. The web UI primitives: a seeded toast, a status chip in the header
    //     and an editor widget above the composer.
    const fixtureToast = page.locator(".app-toast", { hasText: "Fixture toast" });
    await fixtureToast.waitFor({ state: "visible", timeout: 10_000 });
    await page.locator(".app-status-chip", { hasText: "fixture ready" }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await page.locator(".app-widget-lines", { hasText: "fixture widget line" }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    // The toast expires client-side.
    await fixtureToast.waitFor({ state: "hidden", timeout: 12_000 });

    step("4b: realtime streaming + markdown + tool calls");
    // 4b. Realtime streaming, markdown and collapsible tool calls: the
    //     fixture session simulates a full agent turn when prompted (its
    //     composer region is overridden, so the prompt goes through the API).
    await page.setViewportSize({ width: 800, height: 400 });
    const promptRes = await fetch(`${BASE}/api/agent/__test_session__`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prompt", message: "show the plan" }),
    });
    assert.equal(promptRes.status, 200);

    // The streamed reply is visible before the turn completes (realtime).
    await page.waitForFunction(
      () => {
        const el = document.querySelector(".msg-streaming");
        return el !== null && (el.textContent ?? "").length > 5;
      },
      undefined,
      { timeout: 10_000 },
    );
    const midStream = await page.evaluate(
      () => document.querySelector(".msg-streaming")?.textContent ?? "",
    );
    assert.ok(
      !midStream.includes("All checks passed"),
      "mid-stream text must not contain the final line",
    );

    // The completed turn lands in history as rendered markdown.
    const done = page.locator(".msg-assistant", { hasText: "All checks passed" });
    await done.first().waitFor({ state: "visible", timeout: 15_000 });
    assert.ok((await page.locator(".markdown-body strong").count()) >= 1, "bold renders");
    assert.ok((await page.locator(".markdown-body li").count()) >= 2, "list items render");
    assert.ok((await page.locator(".markdown-body pre code").count()) >= 1, "code fences render");
    assert.ok((await page.locator(".markdown-body tbody tr").count()) >= 2, "tables render");
    assert.ok((await page.locator(".markdown-body blockquote").count()) >= 1, "blockquotes render");

    // Tool calls are expanded by default — the bash command and result are
    // the point of the row — and collapse on toggle.
    const toolToggle = page.locator(".msg-toolcall-toggle").first();
    await toolToggle.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      await toolToggle.getAttribute("aria-expanded"),
      "true",
      "tool calls start expanded",
    );
    const toolBody = page.locator(".msg-toolcall-body").first();
    await toolBody.waitFor({ state: "visible", timeout: 5_000 });
    const toolBodyText = (await toolBody.textContent()) ?? "";
    assert.ok(toolBodyText.includes("ls plans/"), "the expanded row shows the tool input");
    assert.ok(toolBodyText.includes("plans.md"), "the expanded row shows the tool result");
    await toolToggle.click();
    assert.equal(await toolToggle.getAttribute("aria-expanded"), "false", "tool calls collapse");

    // The jump-to-latest button appears when scrolled up and returns to the
    // bottom on click.
    await page.evaluate(() => {
      const el = document.querySelector(".app-transcript");
      if (el !== null) el.scrollTop = 0;
    });
    const jumpButton = page.locator(".app-jump-latest");
    await jumpButton.waitFor({ state: "visible", timeout: 5_000 });
    await jumpButton.click();
    await page.waitForFunction(
      () => {
        const el = document.querySelector(".app-transcript");
        if (el === null) return false;
        return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      },
      undefined,
      { timeout: 5_000 },
    );
    await jumpButton.waitFor({ state: "hidden", timeout: 5_000 });
    await page.setViewportSize({ width: 1280, height: 720 });

    step("4c: slash command palette");
    // 4c. (moved to step 8 — the fixture session's composer region is
    //     overridden, and the bridge session exercises the real one.)

    step("4e: persistent dark/light theme");
    // 4e. The sidebar toggle flips data-theme, the choice survives a reload,
    //     and the palette actually applies. Headless defaults to light, so
    // "before" can be either theme — assert per-theme expectations.
    const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.locator(".app-theme-toggle").click();
    const themeAfter = themeBefore === "light" ? "dark" : "light";
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.theme),
      themeAfter,
      "toggle flips the theme",
    );
    await page.reload();
    await page.locator(".app-session-item").first().waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.theme),
      themeAfter,
      "theme persists across reload",
    );
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
      themeAfter === "light" ? "rgb(247, 248, 250)" : "rgb(16, 18, 20)",
      "the active theme's palette applies",
    );
    // Back to the starting theme for the rest of the run.
    if (themeBefore !== themeAfter) await page.locator(".app-theme-toggle").click();

    step("4f: narrow viewport — overlay sidebar, no horizontal overflow");
    // 4f. The web-hostile layout fix: at phone width the sidebar collapses
    //     off-canvas behind a ☰ toggle, and plugin views/regions fit without
    //     a horizontal scrollbar.
    await page.setViewportSize({ width: 420, height: 800 });
    await page.locator(".app-sidebar-toggle").waitFor({ state: "visible", timeout: 10_000 });
    assert.ok(
      await page.evaluate(() => document.querySelector(".app-sidebar-wrap") !== null),
      "the sidebar wrapper exists",
    );
    // Off-canvas, then the ☰ opens the overlay with a scrim.
    await page.waitForFunction(
      () => {
        const el = document.querySelector(".app-sidebar-wrap");
        return el !== null && getComputedStyle(el).transform.includes("-21");
      },
      undefined,
      { timeout: 5_000 },
    );
    await page.locator(".app-sidebar-toggle").click();
    await page.locator(".app-sidebar").waitFor({ state: "visible", timeout: 5_000 });
    assert.ok(await page.locator(".app-sidebar-scrim").isVisible(), "scrim shows behind the overlay");
    // Selecting a session closes the overlay again.
    await page.locator(".app-session-item").first().click();
    await page.waitForFunction(
      () => {
        const el = document.querySelector(".app-sidebar-wrap");
        return el !== null && getComputedStyle(el).transform.includes("-21");
      },
      undefined,
      { timeout: 5_000 },
    );
    // The composer override (a plugin view) still fits.
    await page.locator('[data-region-override="composer"]').waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
      false,
      "no horizontal scrollbar at 420px",
    );
    await page.setViewportSize({ width: 1280, height: 800 });

    step("5: Alt+M shortcut");
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

    step("6: plugin page");
    // 6. Plugin page: the subagent monitor graph renders with expandable nodes.
    await page.goto(`${BASE}/plugins/subagent-monitor`);
    await page.waitForSelector(".plugin-view-graph", { timeout: 20_000 });
    assert.equal(await page.locator(".app-header .app-title").textContent(), "Subagent monitor");
    assert.ok(
      await page.locator(".plugin-graph-node-label", { hasText: "Fixture parent" }).first().isVisible(),
      "the graph shows the fixture parent node",
    );

    step("7: confirmed action round trip");
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

    step("8: bridge sync");
    // 8. Bridge sync: a fake TUI attaches its live session to the web; a
    //    prompt typed in the browser reaches it as a command, and the events
    //    it posts stream back to the browser — one session, two frontends.
    await page.goto(`${BASE}/`);
    await page.waitForSelector(".app-shell", { timeout: 20_000 });

    const bridgeId = "bridge-e2e-session";
    step("8: bridge attach fetched");
    const bridgeCommands = [];
    const bridgeController = new AbortController();
    const bridgeAttach = await fetch(
      `${BASE}/api/bridge/${bridgeId}/attach?cwd=${encodeURIComponent("/tmp/bridge-proj")}`,
      { signal: bridgeController.signal, headers: { accept: "text/event-stream" } },
    );
    assert.equal(bridgeAttach.status, 200);
    const bridgeReader = bridgeAttach.body.getReader();
    const bridgeReadLoop = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await bridgeReader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let separator = buffer.indexOf("\n\n");
        while (separator >= 0) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          if (frame.startsWith("data:")) {
            try {
              const parsed = JSON.parse(frame.slice(5).trim());
              if (parsed.type === "bridge_command") bridgeCommands.push(parsed.command);
            } catch {
              // Not a data frame we understand.
            }
          }
          separator = buffer.indexOf("\n\n");
        }
      }
    })();
    // A server teardown mid-run must not crash the runner with an unhandled
    // rejection before the real assertion error can surface.
    bridgeReadLoop.catch(() => undefined);
    // The bridged session appears in the sidebar as live — select it.
    await page.waitForSelector(`.app-session-item[data-id="${bridgeId}"]`, { timeout: 15_000 });
    await page.click(`.app-session-item[data-id="${bridgeId}"]`);
    step("8: selected, composer");
    // No override on this session: the real composer renders and enables.
    const composerInput = page.locator(".app-composer-input");
    await composerInput.waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForFunction(
      () => document.querySelector(".app-composer-input")?.disabled === false,
      undefined,
      { timeout: 15_000 },
    );

    step("8b: slash command palette");
    // 8b. The palette on the real composer: "/" lists pi's built-ins; a
    //     TUI-only one is blocked with an honest notice instead of being
    //     fed to the model as a prompt.
    await composerInput.fill("/");
    await page.waitForSelector(".app-command-palette", { timeout: 5_000 });
    assert.ok(
      (await page.locator(".app-command-name", { hasText: "/settings" }).count()) === 1,
      "the palette lists pi's built-ins",
    );
    await composerInput.fill("/mod");
    await page.locator(".app-command-item", { hasText: "/model" }).first().waitFor({
      state: "visible",
      timeout: 5_000,
    });
    await composerInput.fill("/model");
    await composerInput.press("Enter");
    const notice = page.locator(".app-composer-error");
    await notice.waitFor({ state: "visible", timeout: 5_000 });
    assert.ok(
      (await notice.textContent())?.includes("TUI command"),
      "the TUI-only command is blocked with a notice",
    );
    await composerInput.fill("");

    step("8: prompting from browser");
    // Prompt in the browser → the fake TUI receives it as a bridge command.
    await composerInput.fill("hello from the web");
    await composerInput.press("Enter");
    const promptEcho = page.locator(".msg-user", { hasText: "hello from the web" });
    await promptEcho.first().waitFor({ state: "visible", timeout: 10_000 });
    const commandDeadline = Date.now() + 10_000;
    while (bridgeCommands.length === 0 && Date.now() < commandDeadline) {
      await page.waitForTimeout(100);
    }
    assert.deepEqual(
      bridgeCommands[0],
      { type: "prompt", message: "hello from the web" },
      "the browser prompt must reach the TUI as a bridge command",
    );

    step("8: command received, streaming reply");
    // The TUI streams its reply; the browser renders it.
    await fetch(`${BASE}/api/bridge/${bridgeId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          { type: "agent_start" },
          { type: "message_start", message: { role: "assistant", content: [] } },
          { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
          { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello from " } },
          { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "the TUI!" } },
          { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello from the TUI!" } },
          { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello from the TUI!" }] } },
          { type: "agent_settled" },
        ],
      }),
    });
    const tuiReply = page.locator(".msg-assistant", { hasText: "Hello from the TUI!" });
    await tuiReply.first().waitFor({ state: "visible", timeout: 15_000 });

    step("8: reply rendered, detaching");
    // Detach: the browser stream ends and the session falls back to disk.
    const detachRes = await fetch(`${BASE}/api/bridge/${bridgeId}/detach`, { method: "POST" });
    assert.equal(detachRes.status, 200);
    bridgeController.abort();
    await bridgeReadLoop.catch(() => undefined);

    step("closing browser");
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
