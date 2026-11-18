// Playwright coverage for manifest-discovered external browser halves: hash-bound
// grant, mount, hash-change re-prompt, safe mode, disable teardown and breaker.
//
// Run with `node web/core/e2e/browser-loading.e2e.mjs`.

import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = 31_500 + Math.floor(Math.random() * 3_000);
const BASE = `http://127.0.0.1:${PORT}`;
const WEB = new URL("../..", import.meta.url).pathname;
const PLUGIN_ID = "acme.external";
const step = (name) => console.log(`[browser-loading-e2e] ${name}`);

const MOUNT_SOURCE = `export function mount(el) {
  const node = document.createElement("div");
  node.className = "acme-external-half";
  node.textContent = "external half";
  el.appendChild(node);
  return () => node.remove();
}
`;
const THROW_SOURCE = `export function mount() {
  throw new Error("external render failure");
}
`;

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

async function confirmGrant(page) {
  const dialog = page.locator(`.browser-grant-dialog[data-plugin-id='${PLUGIN_ID}']`);
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const text = await dialog.locator(".browser-grant-details").innerText();
  for (const part of [PLUGIN_ID, "./dist/browser.js", "sha256:", "ui.publish"]) {
    assert.ok(text.includes(part), `confirmation shows ${part}: ${text}`);
  }
  await dialog.getByRole("button", { name: "Allow browser code" }).click();
  await dialog.waitFor({ state: "hidden", timeout: 5_000 });
}

async function enablePlugin(id) {
  const response = await fetch(`${BASE}/api/plugin-manager/${id}/enable`, { method: "POST" });
  assert.equal(response.ok, true, `enable ${id} before mounting its browser half`);
}

function runtimeState(page) {
  return page.evaluate(() => globalThis.piBrowserRuntime?.state() ?? null);
}

async function externalPackage(dir, source = MOUNT_SOURCE) {
  const packageDir = join(dir, "external-package");
  const pluginDir = join(packageDir, PLUGIN_ID);
  await mkdir(join(pluginDir, "dist"), { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "external-package", pi: { webPlugins: [PLUGIN_ID] } }));
  await writeFile(join(pluginDir, "pi-web-plugin.json"), JSON.stringify({
    id: PLUGIN_ID,
    name: "External Panel",
    version: "1.0.0",
    engines: { piWeb: "^1.0.0", sdk: "^1.0.0" },
    trust: "trusted",
    main: { browser: "./dist/browser.js" },
    capabilities: ["ui.publish"],
    activation: ["onStartup"],
  }));
  await writeFile(join(pluginDir, "dist", "browser.js"), source);
  return packageDir;
}

async function run() {
  if (process.env.PI_WEB_E2E_SKIP_BUILD !== "1") {
    execFileSync("npm", ["run", "build"], { cwd: WEB, stdio: "inherit" });
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-web-browser-loading-e2e-"));
  let browser;
  try {
    const packageDir = await externalPackage(dir);
    const env = { PI_WEB_PLUGIN_ROOTS: packageDir };
    await startServer(dir, env);
    await enablePlugin(PLUGIN_ID);
    browser = await chromium.launch();
    const context = await browser.newContext();
    let page = await context.newPage();

    step("1: metadata and asset are served from the external plugin directory");
    const metadata = await (await fetch(`${BASE}/api/browser-halves`)).json();
    const row = metadata.halves.find((half) => half.id === PLUGIN_ID);
    assert.ok(row, "external half is discovered");
    assert.match(row.hash, /^sha256:[0-9a-f]{64}$/);
    const asset = await fetch(`${BASE}${row.url}`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /^text\/javascript/);

    step("2: the external half requires a hash-bound grant and mounts");
    await page.goto(BASE);
    await page.waitForSelector(".app-shell", { timeout: 20_000 });
    await confirmGrant(page);
    await page.locator(".acme-external-half").waitFor({ state: "visible", timeout: 10_000 });
    assert.ok((await runtimeState(page)).mounted.includes(PLUGIN_ID));
    await page.close();

    step("3: a changed asset revokes the grant until reconfirmed");
    await stopServer();
    await writeFile(join(packageDir, PLUGIN_ID, "dist", "browser.js"), `${MOUNT_SOURCE}\n// changed\n`);
    await startServer(dir, { ...env, PI_WEB_PLUGIN_STATE: join(dir, "plugins-changed.json") });
    await enablePlugin(PLUGIN_ID);
    page = await context.newPage();
    await page.goto(BASE);
    await page.waitForSelector(".app-shell", { timeout: 20_000 });
    await confirmGrant(page);
    await page.locator(".acme-external-half").waitFor({ state: "visible", timeout: 10_000 });
    await page.close();

    step("4: safe mode blocks the non-core half");
    await stopServer();
    await startServer(dir, { ...env, PI_WEB_PLUGIN_STATE: join(dir, "plugins-safe.json"), PI_WEB_SAFE_MODE: "1" });
    page = await context.newPage();
    await page.goto(BASE);
    await page.waitForSelector(".app-shell", { timeout: 20_000 });
    await page.waitForTimeout(1_000);
    assert.equal(await page.locator(".acme-external-half").count(), 0);
    await page.close();

    step("5: disabling the plugin unmounts its contribution");
    await stopServer();
    await startServer(dir, { ...env, PI_WEB_PLUGIN_STATE: join(dir, "plugins-disable.json") });
    await enablePlugin(PLUGIN_ID);
    page = await context.newPage();
    await page.goto(BASE);
    await page.locator(".acme-external-half").waitFor({ state: "visible", timeout: 10_000 });
    await page.evaluate(async (id) => {
      const response = await fetch(`/api/plugin-manager/${id}/disable`, { method: "POST" });
      if (!response.ok) throw new Error(`disable returned ${response.status}`);
    }, PLUGIN_ID);
    await page.reload();
    await page.waitForSelector(".app-shell", { timeout: 20_000 });
    await page.waitForTimeout(1_000);
    assert.equal(await page.locator(".acme-external-half").count(), 0);
    await page.close();

    step("6: a render throw fails closed and trips the breaker");
    await stopServer();
    await writeFile(join(packageDir, PLUGIN_ID, "dist", "browser.js"), THROW_SOURCE);
    await startServer(dir, { ...env, PI_WEB_PLUGIN_STATE: join(dir, "plugins-throw.json") });
    await enablePlugin(PLUGIN_ID);
    page = await context.newPage();
    await page.goto(BASE);
    await page.waitForSelector(".app-shell", { timeout: 20_000 });
    await confirmGrant(page);
    await page.waitForTimeout(1_000);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.evaluate((id) => globalThis.piBrowserRuntime?.remount(id), PLUGIN_ID);
      await page.waitForTimeout(300);
    }
    const failed = await runtimeState(page);
    assert.ok((failed.failures[PLUGIN_ID] ?? 0) >= 1, "render failure is counted");
    assert.ok(failed.quarantined.includes(PLUGIN_ID), "breaker quarantines the failing half");
    assert.equal(await page.locator(".acme-external-half").count(), 0, "built-in UI is restored");

    console.log("[browser-loading-e2e] all checks passed");
  } finally {
    await stopServer();
    if (browser !== undefined) await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(`[browser-loading-e2e] ${error.stack ?? error}`);
  process.exitCode = 1;
});
