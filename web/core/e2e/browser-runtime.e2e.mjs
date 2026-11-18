// Playwright coverage for the trusted browser-half runtime: operator grant,
// composer replacement, transcript restyle, page/command registrations,
// same-frame fallback and breaker, and safe mode with manager re-enable.
//
// Run with `node web/core/e2e/browser-runtime.e2e.mjs`. It builds the client,
// boots an isolated server and cleans up both process group and temp state.

import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = 31_000 + Math.floor(Math.random() * 4_000);
const BASE = `http://127.0.0.1:${PORT}`;
const WEB = new URL("../..", import.meta.url).pathname;
const FIXTURE_PLUGIN = join(WEB, "plugins", "fixture-e2e");
const step = (name) => console.log(`[browser-runtime-e2e] ${name}`);

let server;
let logs = [];
let serverExitCode = null;

async function startServer(dir, extraEnv = {}) {
  logs = [];
  serverExitCode = null;
  server = spawn("npx", ["tsx", "server.ts"], {
    cwd: WEB,
    env: {
      ...process.env,
      PI_WEB_PORT: String(PORT),
      PI_WEB_PLUGIN_STATE: join(dir, "plugins.json"),
      PI_WEB_AUTH_FILE: join(dir, "web-auth.json"),
      PI_WEB_UI_STATE: join(dir, "web-ui-state.json"),
      PI_WEB_TEST_PLUGIN_VIEWS: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  server.stdout.on("data", (chunk) => { logs.push(String(chunk)); });
  server.stderr.on("data", (chunk) => { logs.push(String(chunk)); });
  server.once("exit", (code) => { serverExitCode = code ?? -1; });
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (serverExitCode !== null) throw new Error(`server exited (${serverExitCode}): ${logs.join("")}`);
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become healthy: ${logs.join("")}`);
}

async function stopServer() {
  if (server === undefined || serverExitCode !== null) return;
  try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill("SIGTERM"); }
  await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  try { process.kill(-server.pid, "SIGKILL"); } catch { /* already gone */ }
  server = undefined;
}

async function confirmFixture(page) {
  const dialog = page.locator(".browser-grant-dialog[data-plugin-id='fixture.e2e']");
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const text = await dialog.locator(".browser-grant-details").innerText();
  for (const part of ["fixture.e2e", "0.1.0", "./dist/browser.js", "sha256:", "ui.replace"]) {
    assert.ok(text.includes(part), `confirmation shows ${part}`);
  }
  await dialog.getByRole("button", { name: "Allow browser code" }).click();
  await dialog.waitFor({ state: "hidden", timeout: 5_000 });
}

async function enablePlugin(id) {
  const response = await fetch(`${BASE}/api/plugin-manager/${id}/enable`, { method: "POST" });
  assert.equal(response.ok, true, `enable ${id} before mounting its browser half`);
}

async function runtimeState(page) {
  return page.evaluate(() => globalThis.piBrowserRuntime?.state() ?? null);
}

async function externalFixtureRoot(dir) {
  execFileSync("npm", ["run", "build"], { cwd: FIXTURE_PLUGIN, stdio: "inherit" });
  const root = join(dir, "external-package");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "external-browser-fixture-package",
    private: true,
    type: "module",
    pi: { webPlugins: ["fixture.e2e"] },
  }, null, 2)}\n`);
  await cp(FIXTURE_PLUGIN, join(root, "fixture.e2e"), { recursive: true });
  await writeFile(join(root, "fixture.e2e", "pi-web-plugin.json"), `${JSON.stringify({
    id: "fixture.e2e",
    name: "Browser Runtime Fixture",
    version: "0.1.0",
    engines: { piWeb: "^1.0.0", sdk: "^1.0.0" },
    trust: "trusted",
    main: { browser: "./dist/browser.js" },
    capabilities: ["ui.replace:chat.composer", "ui.route", "commands", "keys", "ui.theme"],
    activation: ["onStartup"],
    contributes: { title: "Browser Runtime Fixture" },
  }, null, 2)}\n`);
  return root;
}

async function run() {
  if (process.env.PI_WEB_E2E_SKIP_BUILD !== "1") {
    execFileSync("npm", ["run", "build"], { cwd: WEB, stdio: "inherit" });
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-web-browser-runtime-e2e-"));
  let browser;
  try {
    step("0: install the fixture plugin from an external discovery root");
    const externalRoot = await externalFixtureRoot(dir);
    await startServer(dir, { PI_WEB_PLUGIN_ROOTS: externalRoot });
    await enablePlugin("fixture.e2e");
    browser = await chromium.launch();
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      window.__piEventSources = [];
      window.EventSource = class extends NativeEventSource {
        constructor(...args) {
          super(...args);
          window.__piEventSources.push(this);
        }
      };
    });
    const page = await context.newPage();

    step("1: trusted half requires an explicit hash-bound grant");
    await page.goto(BASE);
    await page.waitForSelector(".app-shell", { timeout: 20_000 });
    await confirmFixture(page);
    await page.locator(".fixture-composer").waitFor({ state: "visible", timeout: 10_000 });
    const composerHidden = await page.locator(".app-composer").first().evaluate((element) => element.style.display);
    assert.equal(composerHidden, "none", "built-in composer is hidden while the replacement renders");

    step("1b: the web-bridge half renders all five ctx.ui surfaces as host views");
    await page.locator(".web-bridge-views[data-plugin-id='web-bridge']").waitFor({ state: "attached", timeout: 10_000 });
    // Bridged envelopes arrive on the selected session's event stream.
    await page.click('.app-session-item[data-id="__test_session__"]');
    await page.waitForFunction(() =>
      window.__piEventSources.some((source) => source.url.includes("/api/agent/__test_session__/events")), undefined, { timeout: 10_000 });
    await page.evaluate(() => {
      const surfaces = {
        "ui.header.changed": { text: "A bridged header" },
        "ui.footer.changed": { text: "A bridged footer" },
        "ui.status.changed": { text: "A bridged status" },
        "ui.title.changed": { text: "A bridged title" },
        "ui.widget.changed": { key: "w", lines: ["A bridged widget"] },
      };
      for (const [index, [name, payload]] of Object.entries(surfaces).entries()) {
        const bridged = {
          protocol: "pi-web-bridge", version: 1, kind: "event", name,
          messageId: `e2e-bridge-${index}`,
          source: { type: "extension", id: "fixture.ext" },
          timestamp: 0, payload,
        };
        const frame = {
          protocol: "pi-web-bridge", version: 1, kind: "event", name: "session.events",
          messageId: `e2e-session-${index}`,
          source: { type: "core", id: "server" },
          timestamp: 0,
          payload: { type: "protocol_envelope", envelope: bridged },
        };
        for (const source of window.__piEventSources) {
          source.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
        }
      }
    });
    for (const label of ["Header", "Footer", "Status", "Title", "Widget"]) {
      await page.locator(".web-bridge-view-list").getByText(new RegExp(`${label} · fixture\\.ext`))
        .first().waitFor({ state: "visible", timeout: 10_000 });
    }

    step("2: transcript restyle, command, page, keys and theme registrations");
    await page.click('.app-session-item[data-id="__test_session__"]');
    await page.locator(".fixture-transcript-restyled").waitFor({ state: "visible", timeout: 10_000 });
    await page.locator(".fixture-command-button").first().click();
    assert.equal(await page.locator(".fixture-command-result").first().innerText(), "fixture command ran");
    const state = await runtimeState(page);
    const keys = state.contributions.map((entry) => `${entry.point}:${entry.key}`);
    for (const expected of ["ui.component.replace:chat.composer", "ui.region.wrap:transcript",
      "ui.page:/plugins/fixture-e2e", "commands:fixture.e2e.run", "keys:Alt+Shift+F",
      "themes:fixture-dark", "tokens:accent", "protocol.hooks:ui.status.changed"]) {
      assert.ok(keys.includes(expected), `${expected} registered`);
    }
    await page.goto(`${BASE}/plugins/fixture-e2e`);
    await page.locator(".fixture-page").waitFor({ state: "visible", timeout: 10_000 });

    step("3: a render throw restores the built-in in the same frame and counts failures");
    await page.goto(`${BASE}/?fixtureThrow=1`);
    // The grant from step 1 is hash-bound to the same module source, so the
    // throw is a runtime failure, not a new code version needing consent.
    if (await page.locator(".browser-grant-dialog[data-plugin-id='fixture.e2e']").count() > 0) {
      await confirmFixture(page);
    }
    await page.waitForFunction(() =>
      globalThis.piBrowserRuntime?.state().refused["fixture.e2e"] !== undefined, undefined, { timeout: 10_000 });
    assert.equal(await page.locator(".fixture-composer").count(), 0, "throwing half is not mounted");
    assert.notEqual(await page.locator(".app-composer").first().evaluate((element) => element.style.display), "none");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.evaluate(() => globalThis.piBrowserRuntime.remount("fixture.e2e"));
    }
    const failed = await runtimeState(page);
    assert.equal(failed.failures["fixture.e2e"], 3);
    assert.ok(failed.quarantined.includes("fixture.e2e"), "breaker quarantines the half");

    step("4: safe mode blocks non-core halves; the manager can re-enable them");
    await stopServer();
    await startServer(join(dir, "safe"), { PI_WEB_PLUGIN_ROOTS: externalRoot, PI_WEB_SAFE_MODE: "1" });
    const safeContext = await browser.newContext();
    const safePage = await safeContext.newPage();
    await safePage.goto(BASE);
    await safePage.waitForSelector(".app-shell", { timeout: 20_000 });
    await safePage.waitForTimeout(1_500);
    assert.equal(await safePage.locator(".browser-grant-dialog[data-plugin-id='fixture.e2e']").count(), 0);
    assert.equal(await safePage.locator(".fixture-composer").count(), 0);
    assert.equal((await runtimeState(safePage))?.safeMode, true);
    const enabled = await safePage.evaluate(async () => {
      const response = await fetch("/api/plugin-manager/kernel/clear-safe-mode", { method: "POST" });
      return response.ok;
    });
    assert.equal(enabled, true, "leave-safe-mode action succeeds");
    await enablePlugin("fixture.e2e");
    // The manager broadcasts a registry change, which reloads the tab; the
    // fresh runtime then rescans with safe mode off. Nudge it without awaiting
    // a promise that a reload could destroy mid-flight.
    await safePage.waitForLoadState("domcontentloaded");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await safePage.locator(".browser-grant-dialog[data-plugin-id='fixture.e2e']").count() > 0) break;
      await safePage.evaluate(() => { void globalThis.piBrowserRuntime?.scan(); });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await confirmFixture(safePage);
    await safePage.locator(".fixture-composer").waitFor({ state: "visible", timeout: 10_000 });
    assert.ok((await runtimeState(safePage)).mounted.includes("fixture.e2e"), "manager re-enable mounts the half");
    await safeContext.close();
    console.log("[browser-runtime-e2e] all checks passed");
  } finally {
    if (browser !== undefined) await browser.close().catch(() => undefined);
    await stopServer();
    await rm(dir, { recursive: true, force: true });
  }
}

run().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    if (logs.length > 0) console.error(logs.join(""));
    process.exit(1);
  },
);
