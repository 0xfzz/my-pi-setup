// End-to-end suite for the minimal pi-web client. Drives the standalone
// server with the fixture session (PI_WEB_TEST_PLUGIN_VIEWS=1) through a
// real browser: the base shell, session selection, plugin slots, the
// composer region override, plugin pages, the confirmed-action round trip
// (realtime view update without reload) and the instant-action shortcut.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
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

/** Wait for a bridge command matching the predicate (10s deadline). */
async function waitForBridgeCommand(commands, matches, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = commands.find(matches);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`bridge command not received within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

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
      // Isolate web auth too: otherwise the developer's real
      // ~/.pi/agent/web-auth.json enables the password gate and step 1 stalls
      // on the login screen instead of the fixture shell.
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

    step("1b: minimalist shell — search and desktop sidebar toggle");
    await page.getByRole("heading", { name: "What are we working on?" }).waitFor();
    const sessionSearch = page.getByRole("searchbox", { name: "Search sessions" });
    await sessionSearch.fill("no-such-workspace-9c2f");
    await page.getByText("No matching sessions.", { exact: true }).waitFor();
    assert.equal(await page.locator(".app-session-item").count(), 0);
    await sessionSearch.fill("__test_session__");
    await page.locator('.app-session-item[data-id="__test_session__"]').waitFor();
    assert.equal(await page.locator(".app-session-item").count(), 1);
    await sessionSearch.fill("");
    const sessionToggle = page.getByRole("button", { name: "Toggle session list" });
    await sessionToggle.click();
    await page.locator(".app-sidebar").waitFor({ state: "hidden" });
    assert.equal(await sessionToggle.getAttribute("aria-expanded"), "false");
    await sessionToggle.click();
    await page.locator(".app-sidebar").waitFor({ state: "visible" });
    assert.equal(await sessionToggle.getAttribute("aria-expanded"), "true");

    step("2: sidebar plugin icons — clean chat, open, switch and close");
    await selectFixtureSession(page);
    const panelNav = page.getByRole("navigation", { name: "Plugin panels" });
    await panelNav.waitFor();
    assert.equal(await panelNav.locator("button").count(), 5, "one icon per published sidebar plugin");
    assert.equal(await panelNav.locator("button svg").count(), 5, "each plugin has an icon");
    assert.equal(await page.locator(".plugin-slot-region").count(), 0, "sidebar plugins never duplicate into the chat");
    assert.equal(await page.locator(".app-side-panel").count(), 0, "panels start closed");

    const artifactsButton = panelNav.getByRole("button", { name: "Artifacts", exact: true });
    const delegatedButton = panelNav.getByRole("button", { name: "Delegated work", exact: true });
    await artifactsButton.click();
    await page.getByRole("complementary", { name: "Artifacts panel" }).waitFor();
    assert.equal(await artifactsButton.getAttribute("aria-pressed"), "true");
    assert.ok((await page.locator(".app-side-panel").textContent()).includes("prd-phase-6.md"));
    await delegatedButton.click();
    await page.getByRole("complementary", { name: "Delegated work panel" }).waitFor();
    assert.equal(await page.locator(".app-side-panel").count(), 1);
    assert.equal(await artifactsButton.getAttribute("aria-pressed"), "false");
    assert.equal(await delegatedButton.getAttribute("aria-pressed"), "true");
    assert.ok((await page.locator(".app-side-panel").textContent()).includes("worker-slots"));
    await delegatedButton.click();
    assert.equal(await page.locator(".app-side-panel").count(), 0, "clicking the active icon closes its panel");

    await panelNav.getByRole("button", { name: "Todo", exact: true }).click();
    await page.getByRole("complementary", { name: "Todo panel" }).waitFor();
    assert.ok((await page.locator(".app-side-panel").textContent()).includes("Implement frontend slots"));
    await page.getByRole("button", { name: "Close panel", exact: true }).click();
    await panelNav.getByRole("button", { name: "Cache health", exact: true }).click();
    await page.getByRole("complementary", { name: "Cache health panel" }).waitFor();
    assert.ok((await page.locator(".app-side-panel").textContent()).includes("XSS Test"));
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".app-side-panel").count(), 0, "Escape closes the selected panel");

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

    // Mermaid fences render to an SVG client-side; the render is async (the
    // mermaid chunk lazy-loads first), so wait for the diagram to appear.
    await page.locator(".markdown-mermaid svg").first().waitFor({ state: "visible", timeout: 15_000 });
    assert.ok((await page.locator(".markdown-mermaid svg").count()) >= 1, "mermaid renders an SVG");

    // Tailwind's preflight resets `list-style: none` and the markdown styles
    // must restore the markers, or bullets/numbers silently disappear.
    const ulMarker = await page
      .locator(".markdown-body ul")
      .first()
      .evaluate((el) => getComputedStyle(el).listStyleType);
    assert.equal(ulMarker, "disc", "bulleted lists show disc markers");
    const olMarker = await page
      .locator(".markdown-body ol")
      .first()
      .evaluate((el) => getComputedStyle(el).listStyleType);
    assert.equal(olMarker, "decimal", "numbered lists show decimal markers");

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
      themeAfter === "light" ? "rgb(255, 255, 255)" : "rgb(25, 25, 25)",
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
        return el !== null && el.getBoundingClientRect().right <= 0;
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
        return el !== null && el.getBoundingClientRect().right <= 0;
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
    // Navbar icons stay reachable on phones; closing an overlay restores the chat.
    await page.getByRole("navigation", { name: "Plugin panels" }).getByRole("button", { name: "Artifacts", exact: true }).click();
    await page.getByRole("complementary", { name: "Artifacts panel" }).waitFor();
    await page.getByRole("button", { name: "Close panel", exact: true }).click();
    assert.equal(await page.locator(".app-side-panel-scrim").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator(".app-sidebar-toggle").click();

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
    // A panel from the previous session must not leak into this one.
    await page.getByRole("navigation", { name: "Plugin panels" }).getByRole("button", { name: "Artifacts", exact: true }).click();
    await page.getByRole("complementary", { name: "Artifacts panel" }).waitFor();
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

    await page.getByRole("navigation", { name: "Plugin panels" }).waitFor({ state: "hidden" });
    assert.equal(await page.locator(".app-side-panel").count(), 0, "switching sessions clears stale panel content");

    step("8b: slash command palette, model picker, web dialogs");
    // 8b. The palette on the real composer: "/" lists pi's built-ins; the
    //     TUI dialog port opens web dialogs. The fake TUI posts its model
    //     list (web_models) and current state (session_state) like the real
    //     extension does, so the chip and picker have data.
    await fetch(`${BASE}/api/bridge/${bridgeId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "web_models",
            current: { provider: "anthropic", id: "claude-4-5" },
            models: [
              { provider: "anthropic", id: "claude-4-5" },
              { provider: "google", id: "gemini-3-pro" },
              { provider: "openai", id: "gpt-6" },
            ],
          },
          { type: "session_state", model: { provider: "anthropic", id: "claude-4-5" }, thinkingLevel: "low" },
        ],
      }),
    });
    // The model chip at the composer shows the synced current model.
    const modelChip = page.locator(".app-model-chip");
    await modelChip.waitFor({ state: "visible", timeout: 10_000 });
    assert.ok(
      (await modelChip.textContent())?.includes("claude-4-5"),
      "the model chip shows the synced current model",
    );
    // The context-window meter reads the bridge's session state on the next
    // settle refetch and renders its usage just above the prompt.
    await fetch(`${BASE}/api/bridge/${bridgeId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: { contextUsage: { percent: 42, contextWindow: 200_000, tokens: 84_000 } },
        events: [{ type: "agent_settled" }],
      }),
    });
    const contextMeter = page.locator(".app-context-usage");
    await contextMeter.waitFor({ state: "visible", timeout: 10_000 });
    assert.ok(
      (await contextMeter.textContent())?.includes("42% · 84k / 200k"),
      "the context meter shows the posted context usage",
    );
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
    // Bare /model now opens the web picker (the TUI dialog port) instead of
    // being blocked as TUI-only.
    await composerInput.fill("/model");
    await composerInput.press("Enter");
    const picker = page.locator(".app-dialog[role='dialog']");
    await picker.waitFor({ state: "visible", timeout: 5_000 });
    assert.ok(
      (await page.locator(".app-dialog-item", { hasText: "gemini-3-pro" }).count()) > 0,
      "the picker lists the posted models",
    );
    // Search narrows it; picking sends set_model to the TUI and updates the
    // chip optimistically.
    await page.locator(".app-dialog-search").fill("gemini");
    await page.locator(".app-dialog-item", { hasText: "gemini-3-pro" }).first().click();
    const modelCommand = await waitForBridgeCommand(bridgeCommands, (command) => command.type === "set_model");
    assert.deepEqual(
      modelCommand,
      { type: "set_model", provider: "google", id: "gemini-3-pro" },
      "the picked model reaches the TUI as a set_model command",
    );
    await page.locator(".app-model-chip", { hasText: "gemini-3-pro" }).waitFor({
      state: "visible",
      timeout: 5_000,
    });
    // Every built-in is now dispatchable from the web (13 web-ported +
    // 11 web-channel); nothing is TUI-only anymore, so /share dispatches
    // through the web channel like the other core commands rather than
    // being blocked. (Its bridge-channel assertion lives with 8e2.)
    await composerInput.fill("");

    step("8c: extension dialog view (the web extension surface)");
    // 8c. An extension publishes a dialog view with actions; the web renders
    //     it modally and the action dispatches through the plugin pipeline
    //     back to the TUI. The modes plugin is registered with a
    //     "toggle-mode" action, so its dialog button dispatches for real.
    await fetch(`${BASE}/api/bridge/${bridgeId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "web_plugin_view",
            payload: {
              pluginId: "modes",
              view: {
                type: "dialog",
                title: "Switch input mode?",
                body: "**Alt+M does this instantly.**",
                actions: [
                  { id: "toggle-mode", label: "Switch mode", tone: "primary" },
                ],
              },
            },
          },
        ],
      }),
    });
    const extDialog = page.locator(".app-dialog", { hasText: "Switch input mode?" });
    await extDialog.waitFor({ state: "visible", timeout: 10_000 });
    assert.ok(
      (await page.locator(".app-dialog-action", { hasText: "Switch mode" }).count()) === 1,
      "the dialog view renders its actions",
    );
    await page.locator(".app-dialog-action", { hasText: "Switch mode" }).click();
    const actionCommand = await waitForBridgeCommand(bridgeCommands, (command) => command.type === "action");
    assert.equal(actionCommand.pluginId, "modes", "the action routes back with its plugin id");
    assert.equal(actionCommand.actionId, "toggle-mode", "the action routes back with its action id");
    // Publishing open:false closes it.
    await fetch(`${BASE}/api/bridge/${bridgeId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "web_plugin_view",
            payload: {
              pluginId: "modes",
              view: { type: "dialog", title: "Switch input mode?", lines: ["x"], open: false },
            },
          },
        ],
      }),
    });
    await extDialog.waitFor({ state: "hidden", timeout: 10_000 });

    step("8d: @ mention — pi's provider drives the picker, the mention rides the prompt as text");
    // 8d. The @file built-in, pi-native: the picker's suggestions come from
    //     pi's own editor autocomplete (pi_api autocomplete.suggestions —
    //     fd walk + fuzzy ranking on the session cwd), the picked path
    //     inserts as @path, and the sent prompt passes through as typed —
    //     pi's read tool resolves the mention model-side. No inlining.
    const { writeFile: e2eWriteFile, mkdir: e2eMkdir } = await import("node:fs/promises");
    await e2eMkdir("/tmp/bridge-proj", { recursive: true });
    await e2eWriteFile("/tmp/bridge-proj/secret.txt", "e2e-mention-payload", "utf8");
    await composerInput.fill("summarize @sec");
    await page.locator(".app-command-palette[aria-label='Files']").waitFor({
      state: "visible",
      timeout: 10_000,
    });
    const mentionRow = page.locator(".app-command-item", { hasText: "secret.txt" }).first();
    await mentionRow.waitFor({ state: "visible", timeout: 5_000 });
    await mentionRow.click();
    // Insertion replaces the partial token and leaves the mention in text.
    await page.waitForFunction(
      () => document.querySelector(".app-composer-input")?.value.includes("@secret.txt"),
      undefined,
      { timeout: 5_000 },
    );
    await composerInput.press("Enter");
    const mentionPrompt = await waitForBridgeCommand(
      bridgeCommands,
      (command) => command.type === "prompt" && command.message.includes("secret.txt"),
    );
    assert.equal(
      mentionPrompt.message,
      "summarize @secret.txt ",
      "the mention rides the prompt as text — the model reads it with pi's read tool",
    );

    step("8e: web core commands dispatch through the web channel");
    // 8e. The web core registry: the bridge posts the commands with web:true,
    //     the composer dispatches /compact through the web_command channel
    //     (not prompt text), and the pi process runs the registry handler.
    await fetch(`${BASE}/api/bridge/${bridgeId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "web_commands",
            commands: [{ name: "compact", description: "Compact the session context (web core)", web: true }],
          },
        ],
      }),
    });
    // The command list refreshes via /commands on the next fetch; the
    // composer reads it when the palette opens.
    await composerInput.fill("/compact");
    await page.locator(".app-command-item", { hasText: "compact" }).first().waitFor({
      state: "visible",
      timeout: 5_000,
    });
    await composerInput.press("Enter");
    const webCommand = await waitForBridgeCommand(
      bridgeCommands,
      (command) => command.type === "web_command",
    );
    assert.deepEqual(
      webCommand,
      { type: "web_command", name: "compact" },
      "the web core command rides its own channel to the pi process",
    );
    // The composer cleared: the command did not go out as prompt text.
    assert.equal(await composerInput.inputValue(), "");

    step("8e-reload: the reload indicator tracks a dispatched /reload");
    await composerInput.fill("/reload");
    await page.locator(".app-command-item", { hasText: "reload" }).first().waitFor({
      state: "visible",
      timeout: 5_000,
    });
    await composerInput.press("Enter");
    await page.locator(".app-reloading-banner").waitFor({ state: "visible", timeout: 5_000 });
    // The extension re-posts its command list after it has re-run; that is the
    // completion signal that clears the banner.
    await fetch(`${BASE}/api/bridge/${bridgeId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "web_commands", commands: [{ name: "compact", description: "Compact (web core)", web: true }] }],
      }),
    });
    await page.locator(".app-reloading-banner").waitFor({ state: "hidden", timeout: 5_000 });

    step("8: prompting from browser");
    // Prompt in the browser → the fake TUI receives it as a bridge command.
    await composerInput.fill("hello from the web");
    await composerInput.press("Enter");
    const promptEcho = page.locator(".msg-user", { hasText: "hello from the web" });
    await promptEcho.first().waitFor({ state: "visible", timeout: 10_000 });
    // Earlier steps (set_model, plugin action) already sent commands; find
    // THIS prompt among them.
    const promptCommand = await waitForBridgeCommand(
      bridgeCommands,
      (command) => command.type === "prompt" && command.message.startsWith("hello from the web"),
    );
    assert.deepEqual(
      promptCommand,
      { type: "prompt", message: "hello from the web" },
      "the browser prompt must reach the TUI as a bridge command",
    );

    // The confirmed echo: the real pi writes the prompt to the session and
    // the extension forwards message_end (role user) back — the optimistic
    // row dedupes against it and the transcript shows exactly ONE row.
    await fetch(`${BASE}/api/bridge/${bridgeId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          { type: "message_start", message: { role: "user", content: [] } },
          {
            type: "message_end",
            message: { role: "user", content: [{ type: "text", text: "hello from the web" }] },
          },
        ],
      }),
    });
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll(".msg-user")).filter((el) =>
          (el.textContent ?? "").includes("hello from the web"),
        ).length === 1,
      undefined,
      { timeout: 10_000 },
    );

    step("8e2: all built-in commands — bridge channel and web dialogs");
    // 8e2. The built-in coverage: /fork, /tree, /import and /quit are
    //     dispatched through the web_command channel (pi's own context APIs
    //     execute them in the pi process), /hotkeys opens the web's own
    //     keybinding dialog. The composer never feeds them to the model.
    await fetch(`${BASE}/api/bridge/${bridgeId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "web_commands",
            commands: [
              { name: "fork", description: "Fork from a previous user message (web core)", web: true },
              { name: "tree", description: "Navigate the session tree (web core)", web: true },
              { name: "import", description: "Import and resume a session from a JSONL file (web core)", web: true },
              { name: "quit", description: "Gracefully shut down this pi session (web core)", web: true },
            ],
          },
        ],
      }),
    });
    for (const name of ["fork", "tree", "import", "quit"]) {
      await composerInput.fill(`/${name}`);
      await page.locator(".app-command-item", { hasText: name }).first().waitFor({
        state: "visible",
        timeout: 5_000,
      });
      await composerInput.press("Enter");
      const dispatched = await waitForBridgeCommand(
        bridgeCommands,
        (command) => command.type === "web_command" && command.name === name,
      );
      assert.deepEqual(
        dispatched,
        { type: "web_command", name },
        `/${name} dispatches through the bridge channel, not prompt text`,
      );
    }
    // /tree: the web picker fed by pi's tree (the extension posts
    // web_tree; the fake bridge posts it like the real one does). The
    // pick dispatches back with the entry id — pi's navigateTree.
    await fetch(`${BASE}/api/bridge/${bridgeId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "web_tree",
            nodes: [
              { entryId: "e1", label: "user: pick a branch", text: "pick a branch", role: "user", depth: 0, isCurrent: false, isBranch: true },
              { entryId: "e2", label: "assistant: first", text: "first", role: "assistant", depth: 1, isCurrent: true, isBranch: false },
              { entryId: "e3", label: "assistant: second", text: "second", role: "assistant", depth: 1, isCurrent: false, isBranch: false },
            ],
          },
        ],
      }),
    });
    await composerInput.fill("/tree");
    await page.locator(".app-command-item", { hasText: "tree" }).first().waitFor({
      state: "visible",
      timeout: 5_000,
    });
    await composerInput.press("Enter");
    const treeDialog = page.locator(".app-dialog", { hasText: "Session tree" });
    await treeDialog.waitFor({ state: "visible", timeout: 10_000 });
    const treeNodes = await page.locator(".app-tree-node").allTextContents();
    assert.equal(treeNodes.length, 3, "the picker renders pi's posted tree");
    assert.ok(
      (await page.locator(".app-tree-current").count()) === 1,
      "the current leaf is marked",
    );
    // The pick: dispatches /tree <entryId> back to the pi process.
    await page.locator(".app-tree-node", { hasText: "pick a branch" }).click();
    const treePick = await waitForBridgeCommand(
      bridgeCommands,
      (command) => command.type === "web_command" && command.name === "tree" && command.args === "e1",
    );
    assert.deepEqual(
      treePick,
      { type: "web_command", name: "tree", args: "e1" },
      "the tree pick navigates by entry id through pi's navigateTree",
    );

    // /hotkeys: the web's own keymap, a client-side dialog like /session.
    await composerInput.fill("/hotkeys");
    await composerInput.press("Enter");
    await page.locator(".app-dialog", { hasText: "Web Keybindings" }).waitFor({
      state: "visible",
      timeout: 10_000,
    });

    step("8f: reload mid-stream — the partial replays after the reload");
    // 8f. The classic desync: the turn is in flight, the user reloads. The
    //     reattached browser stream never saw message_start, so before the
    //     snapshot replay every delta was dropped and the reply popped in
    //     only at message_end. Now: connected → the partial replays.
    await fetch(`${BASE}/api/bridge/${bridgeId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          { type: "agent_start" },
          { type: "message_start", message: { role: "assistant", content: [] } },
          { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
          {
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "mid-stream partial before",
              partial: { role: "assistant", content: [{ type: "text", text: "mid-stream partial before" }] },
            },
          },
        ],
      }),
    });
    // The partial renders live first.
    await page.locator(".msg-assistant.msg-streaming", { hasText: "mid-stream partial before" })
      .waitFor({ state: "visible", timeout: 10_000 });
    // The reload drops the stream; the turn keeps streaming in the TUI.
    await page.reload();
    await page.locator(".app-composer-input").waitFor({ state: "visible", timeout: 10_000 });
    // The reattached stream replays the partial so the streaming reply is
    // visible again — not a frozen transcript waiting for message_end.
    await page.locator(".msg-assistant.msg-streaming", { hasText: "mid-stream partial before" })
      .waitFor({ state: "visible", timeout: 10_000 });
    // More deltas arrive after the reload and continue the same message.
    await fetch(`${BASE}/api/bridge/${bridgeId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: " and after",
              partial: { role: "assistant", content: [{ type: "text", text: "mid-stream partial before and after" }] },
            },
          },
          { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "mid-stream partial before and after" }] } },
          { type: "agent_settled" },
        ],
      }),
    });
    const reloadedReply = page.locator(".msg-assistant", { hasText: "mid-stream partial before and after" });
    await reloadedReply.first().waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await page.locator(".msg-assistant", { hasText: "mid-stream partial before and after" }).count(), 1, "the completed reply renders exactly once (no live/history duplicate)");

    step("8g: an unfocused running session is marked run in the sidebar");
    // 8g. The sidebar's running mark must reflect OTHER sessions' runs, not
    //     just the selected one: the bridge posts run-level state
    //     (agent_start/settled), /api/sessions carries it, and the sidebar
    //     renders it while the user is focused elsewhere.
    await page.click('.app-session-item[data-id="__test_session__"]');
    await page.locator('.app-session-item[data-id="__test_session__"].is-selected').waitFor({ timeout: 5000 });
    await fetch(`${BASE}/api/bridge/${bridgeId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: { isStreaming: true },
        events: [{ type: "agent_start" }],
      }),
    });
    await page
      .locator(`.app-session-item[data-id="${bridgeId}"][data-state="running"]`)
      .waitFor({ timeout: 10_000 });
    const runMark = await page
      .locator(`.app-session-item[data-id="${bridgeId}"] .app-session-running`)
      .textContent();
    assert.equal(runMark, "run", "the unfocused session shows its running mark");
    // The run settles: the mark clears back to live.
    await fetch(`${BASE}/api/bridge/${bridgeId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: { isStreaming: false },
        events: [{ type: "agent_settled" }],
      }),
    });
    await page
      .locator(`.app-session-item[data-id="${bridgeId}"][data-state="live"]`)
      .waitFor({ timeout: 10_000 });
    step("8h: a session name replaces the folder in the sidebar row");
    // 8h. A bridged rename (a /name, or a generated title) arrives as a
    //     session_name event: the sidebar row shows it in place of the folder,
    //     and the header shows it once the session is selected.
    await fetch(`${BASE}/api/bridge/${bridgeId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [{ type: "session_name", name: "Generated Title Check" }] }),
    });
    await page
      .locator(`.app-session-item[data-id="${bridgeId}"] .app-session-name`)
      .filter({ hasText: "Generated Title Check" })
      .waitFor({ timeout: 10_000 });
    // Return to the bridge session for the remaining steps. The sidebar
    // reorders on activity — wait for the selection AND the stream's
    // connection before events flow, exactly like a user watching the
    // session reconnect (a real TUI's turns are also in the session file;
    // the fake bridge writes none, so events posted pre-subscribe would
    // legitimately be lost to it).
    await page.click(`.app-session-item[data-id="${bridgeId}"]`);
    await page
      .locator(`.app-session-item[data-id="${bridgeId}"].is-selected`)
      .waitFor({ timeout: 5_000 });
    await page
      .locator(".app-header-title")
      .filter({ hasText: "Generated Title Check" })
      .waitFor({ timeout: 10_000 });
    // "connecting" contains "connected" — match the exact terminal states
    // (the model name once state lands, or the bare "connected").
    await page.waitForFunction(
      () => {
        const status = document.querySelector(".app-header-status")?.textContent ?? "";
        return status !== "" && status !== "connecting";
      },
      undefined,
      { timeout: 10_000 },
    );

    step("8: command received, TUI-side prompt, streaming reply");
    // The TUI streams its reply; the browser renders it. The user's prompt
    // (typed in the TUI) rides the same wire — pi emits message_start/end
    // with role user for it — and must render as a user row, 1:1 with the
    // TUI transcript.
    await fetch(`${BASE}/api/bridge/${bridgeId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          { type: "message_start", message: { role: "user", content: [] } },
          {
            type: "message_end",
            message: { role: "user", content: [{ type: "text", text: "hello from the TUI side" }] },
          },
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
    // The TUI-side prompt rendered too — the user's own side of the turn.
    await page
      .locator(".msg-user", { hasText: "hello from the TUI side" })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });

    step("8: reply rendered, detaching");
    // Detach: the browser stream ends and the session falls back to disk.
    const detachRes = await fetch(`${BASE}/api/bridge/${bridgeId}/detach`, { method: "POST" });
    assert.equal(detachRes.status, 200);
    bridgeController.abort();
    await bridgeReadLoop.catch(() => undefined);

    step("9: long session — the tail is the window, not the head");
    // 9. A session file longer than the history limit (a long working day)
    // must render its LAST entries — the newest user message visible, the
    // rolled-off head absent. Reading from the head showed the session's
    // opening instead and looked "not synced" after every reload.
    const longDir = join(
      process.env.HOME ?? "/home/faiz",
      ".pi/agent/sessions/--tmp-pi-web-e2e-long--",
    );
    // Hex-only: pi's session ids are UUID-shaped and the resolver only
    // accepts hex+dash, like the real files it scans.
    const longId = `e2e${Date.now().toString(16)}`;
    const longFile = join(longDir, `2026-11-10T00-00-00-000Z_${longId}.jsonl`);
    await mkdir(longDir, { recursive: true });
    try {
      const lines = [
        JSON.stringify({ type: "session", id: longId, cwd: "/tmp/pi-web-e2e-long", timestamp: "2026-11-10T00:00:00Z" }),
      ];
      for (let i = 1; i <= 250; i++) {
        lines.push(
          JSON.stringify({
            type: "message",
            message: {
              role: i % 2 === 0 ? "assistant" : "user",
              content: [{ type: "text", text: `entry ${i}` }],
            },
          }),
        );
      }
      await writeFile(longFile, lines.join("\n"));

      await page.reload();
      const longRow = page.locator(`.app-session-item[data-id="${longId}"]`);
      await longRow.waitFor({ state: "visible", timeout: 15_000 });
      await longRow.click();
      // The newest user message (249) is in the window; the head (1..50)
      // rolled off. Bounded: 200 rendered entries.
      await page.locator(".msg-user", { hasText: "entry 249" }).first().waitFor({
        state: "visible",
        timeout: 15_000,
      });
      assert.equal(await page.locator(".msg-user, .msg-assistant").count(), 200);
      assert.equal(await page.locator(".msg-user", { hasText: "entry 50" }).count(), 0);
    } finally {
      await rm(longFile, { force: true });
      await rmdir(longDir, { recursive: true, force: true });
    }

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
