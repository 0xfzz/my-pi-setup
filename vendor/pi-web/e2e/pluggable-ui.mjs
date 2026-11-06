import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createJiti } from "jiti";

/** Exercise real React anchors/overrides with an isolated RPC-backed snapshot/SSE fixture.
 * No model request, browser code plugin, or production test endpoint is needed.
 */
export async function checkPluggableUi(page, base) {
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { AgentSessionWrapper } = await jiti.import("../lib/rpc-manager.ts");
  const { webUiStore: store } = await jiti.import("../lib/web-plugins-host.ts");
  store.clear();
  const first = "__test_session__";
  const second = "__ui_other_session__";
  const wrappers = [first, second].map(sessionId => new AgentSessionWrapper({
    sessionId, sessionManager: { getCwd: () => "/fixture" },
    isStreaming: false, isCompacting: false, isBashRunning: false, isIdle: true,
    agent: { state: {}, abort() {} }, abort() {}, dispose() {}, extensionRunner: {},
  }));
  const [firstUi, secondUi] = wrappers.map(wrapper => wrapper.createExtensionUiContext());
  firstUi.setWorkingMessage("First session working");
  firstUi.setWorkingIndicator({ frames: ["·", "●"], intervalMs: 120 });
  secondUi.setWorkingMessage("Second session working");
  secondUi.setWorkingIndicator({ frames: ["◇", "◆"], intervalMs: 160 });
  for (const [id, label] of [[first, "First"], [second, "Second"]]) {
    assert.ok(store.publish(id, "ui.session.lifecycle", { running: id === first, project: "/fixture" }, "fixture", "host"));
    assert.ok(store.publish(id, "ui.view.changed", { pluginId: "ui-fixture", view: { type: "status", text: `${label} session view`, tone: "neutral" } }, "ui-fixture"));
  }
  const contribution = (id, component, placement, extra = {}) => ({ id, component, scope: "session", placement, ...extra });
  const workingPlacement = { kind: "anchor", anchor: "chat.working" };
  const declarations = [
    contribution("composer", "ui.plugin-view.v1", { kind: "anchor", anchor: "chat.composer", maxWidth: 320 }),
    contribution("header", "ui.plugin-view.v1", { kind: "anchor", anchor: "session.header" }, { strategy: "card" }),
    contribution("overlay", "ui.plugin-view.v1", { kind: "overlay", maxWidth: 320, maxHeight: 180, inset: { right: 8, bottom: 8 }, mobileFallback: "chat.after" }),
    contribution("working", "ui.working-indicator.v1", workingPlacement),
    contribution("replacement", "ui.working-indicator.v1", workingPlacement, { priority: 20, strategy: "compact", visibleWhen: "running", override: { target: "ui.working-indicator.v1", mode: "replace", fallback: "builtin" } }),
    contribution("wrapper", "ui.working-indicator.v1", workingPlacement, { priority: 30, strategy: "card", visibleWhen: "running", override: { target: "ui.working-indicator.v1", mode: "wrap", fallback: "builtin" } }),
  ];
  let enabled = declarations;
  let forcedSnapshot;
  let snapshotReads = 0;
  const snapshot = () => {
    const ui = forcedSnapshot ?? store.snapshot();
    return {
      plugins: [{ id: "ui-fixture", extension: "ui-fixture", title: "UI fixture", surfaces: [], ui: enabled }],
      ui,
      views: Object.fromEntries(Object.entries(ui.sessions).map(([id, session]) => [id, session.views])),
      sessions: Object.fromEntries(Object.entries(ui.sessions).map(([id, session]) => [id, { running: session.running }])),
    };
  };
  const clients = new Set();
  let connections = 0;
  const change = () => {
    const ui = store.snapshot();
    for (const response of clients) {
      if (!response.writableEnded && !response.destroyed) response.write(`data: ${JSON.stringify({ type: "changed", revision: ui.revision, epoch: ui.epoch })}\n\n`);
    }
  };
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": base });
    response.write("retry: 100\n\n");
    clients.add(response);
    connections++;
    response.on("close", () => clients.delete(response));
    change();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const eventsUrl = `http://127.0.0.1:${server.address().port}/events`;
  const unsubscribe = store.subscribe(change);
  const snapshots = `${base}/api/plugins`;
  const events = `${base}/api/plugins/events`;
  await page.route(snapshots, route => { snapshotReads++; return route.fulfill({ json: snapshot() }); });
  await page.route(events, route => route.fulfill({ status: 302, headers: { location: eventsUrl }, body: "" }));
  const node = id => page.locator(`[data-plugin-id="ui-fixture"][data-contribution-id="${id}"]`);
  const working = node("working").locator('[data-testid="web-ui-working"]');
  const inAnchor = (anchor, id) => page.locator(`[data-web-ui-anchor="${anchor}"] [data-contribution-id="${id}"]`);
  const expectText = async (locator, text) => {
    await locator.filter({ hasText: text }).waitFor({ state: "visible" });
    assert.match(await locator.textContent(), new RegExp(text));
  };
  try {
    await page.goto(`${base}/?session=${first}`, { waitUntil: "load" });
    await expectText(inAnchor("session.header", "header"), "First session view");
    await node("header").locator(".web-ui-card").waitFor({ state: "visible" });
    await expectText(inAnchor("chat.composer", "composer"), "First session view");
    await expectText(inAnchor("viewport.overlay", "overlay"), "First session view");
    await expectText(working, "First session working");
    assert.equal(await working.getAttribute("data-frames"), "·\u0000●");
    assert.equal(await node("working").locator('[data-ui-component]').getAttribute("data-ui-replacement"), "ui-fixture/replacement");
    await node("working").locator('[data-ui-wrapper="ui-fixture/wrapper"] .web-ui-wrap').waitFor();
    const overlayBox = await node("overlay").boundingBox();
    const viewport = page.viewportSize();
    assert.ok(overlayBox && overlayBox.width <= 320 && overlayBox.height <= 180);
    assert.ok(overlayBox.x >= 0 && overlayBox.y >= 0 && overlayBox.x + overlayBox.width <= viewport.width && overlayBox.y + overlayBox.height <= viewport.height);

    // Actual RPC ctx.ui calls -> validated host store -> real SSE -> shared hook -> paint.
    const navigationCount = await page.evaluate(() => performance.getEntriesByType("navigation").length);
    firstUi.setWorkingMessage("Ratiocinating live update");
    firstUi.setWorkingIndicator({ frames: ["◐", "◓", "◑", "◒"], intervalMs: 100 });
    await expectText(working, "Ratiocinating live update");
    assert.equal(await working.getAttribute("data-frames"), "◐\u0000◓\u0000◑\u0000◒");
    assert.equal(await page.evaluate(() => performance.getEntriesByType("navigation").length), navigationCount);
    firstUi.setWorkingVisible(false);
    await working.waitFor({ state: "hidden" });
    firstUi.setWorkingVisible(true);
    await working.waitFor({ state: "visible" });

    // A validated runtime move only changes the owning session.
    assert.ok(store.publish(first, "ui.layout.changed", { pluginId: "ui-fixture", contributionId: "composer", placement: { kind: "anchor", anchor: "chat.after" } }, "ui-fixture"));
    await inAnchor("chat.after", "composer").waitFor({ state: "visible" });
    assert.equal(await inAnchor("chat.composer", "composer").count(), 0);
    assert.equal(store.publish(first, "ui.layout.changed", { pluginId: "ui-fixture", contributionId: "composer", placement: { kind: "anchor", anchor: "auth" } }, "ui-fixture"), false);
    assert.match(store.snapshot().diagnostics.at(-1).message, /anchor/);
    await inAnchor("chat.after", "composer").waitFor({ state: "visible" });

    await page.goto(`${base}/?session=${second}`, { waitUntil: "load" });
    await expectText(working, "Second session working");
    assert.equal(await working.getAttribute("data-frames"), "◇\u0000◆");
    assert.equal(await node("working").locator('[data-ui-component]').getAttribute("data-ui-replacement"), "builtin");
    assert.equal(await node("working").locator('[data-ui-wrapper]').count(), 0, "running-only overrides cannot leak into an idle session");
    await expectText(inAnchor("chat.composer", "composer"), "Second session view");
    assert.doesNotMatch(await node("header").textContent(), /First session/);
    assert.doesNotMatch(await node("overlay").textContent(), /First session/);
    await page.goto(`${base}/?session=${first}`, { waitUntil: "load" });
    await expectText(working, "Ratiocinating live update");
    await inAnchor("chat.after", "composer").waitFor({ state: "visible" });

    // Disconnect while an update is published. onopen/full snapshot must recover it.
    for (const response of clients) response.end();
    firstUi.setWorkingMessage("Recovered after reconnect");
    await expectText(working, "Recovered after reconnect");
    assert.ok(connections >= 2);
    const oldSnapshot = store.snapshot();
    firstUi.setWorkingMessage("Newest working message");
    await expectText(working, "Newest working message");
    forcedSnapshot = oldSnapshot;
    const readsBefore = snapshotReads;
    await Promise.all([
      page.waitForResponse(response => response.url() === snapshots && response.ok()),
      page.evaluate(() => window.dispatchEvent(new Event("online"))),
    ]);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok(snapshotReads > readsBefore);
    assert.match(await working.textContent(), /Newest working message/);
    forcedSnapshot = undefined;

    // Disabling a contribution restores the builtin, with the wrapper still active.
    enabled = declarations.filter(c => c.id !== "replacement");
    firstUi.setWorkingMessage("Builtin after disablement");
    await expectText(working, "Builtin after disablement");
    assert.equal(await node("working").locator('[data-ui-component]').getAttribute("data-ui-replacement"), "builtin");
    await node("working").locator('[data-ui-wrapper="ui-fixture/wrapper"]').waitFor();

    // Fault injection at the immutable-model boundary exercises the real React fallback.
    enabled = declarations;
    await page.evaluate(() => {
      window.__fixtureClone = window.structuredClone;
      window.structuredClone = value => {
        if (value?.kind === "working" && value.value?.message === "Renderer failure fixture") throw new Error("fixture renderer failure");
        return window.__fixtureClone(value);
      };
    });
    firstUi.setWorkingMessage("Renderer failure fixture");
    await expectText(working, "Renderer failure fixture");
    assert.equal(await node("working").locator('[data-ui-replacement="ui-fixture/replacement"]').count(), 0);
    await page.evaluate(() => { window.structuredClone = window.__fixtureClone; delete window.__fixtureClone; });
    firstUi.setWorkingMessage("Builtin after renderer failure");
    await expectText(working, "Builtin after renderer failure");
    assert.equal(await node("working").locator('[data-ui-component]').getAttribute("data-ui-replacement"), "builtin");

    await page.setViewportSize({ width: 390, height: 844 });
    await expectText(inAnchor("chat.after", "overlay"), "First session view");
    assert.equal(await inAnchor("viewport.overlay", "overlay").count(), 0);
    const mobileBox = await node("overlay").boundingBox();
    assert.ok(mobileBox && mobileBox.x >= 0 && mobileBox.x + mobileBox.width <= 391);
    await page.setViewportSize({ width: 1440, height: 900 });
    await inAnchor("viewport.overlay", "overlay").waitFor({ state: "visible" });
    await node("overlay").getByRole("button", { name: "Close UI fixture" }).click();
    await node("overlay").waitFor({ state: "hidden" });
    assert.equal(await page.locator('[data-web-ui-anchor="viewport.overlay"]').evaluate(element => document.activeElement === element), true);
    console.log("[pluggable-ui e2e] RPC working updates, anchors, runtime placement, session isolation, reconnect, override fallback and mobile layout passed.");
  } finally {
    await page.evaluate(() => { if (window.__fixtureClone) window.structuredClone = window.__fixtureClone; }).catch(() => {});
    await page.unroute(snapshots);
    await page.unroute(events);
    unsubscribe();
    for (const response of clients) response.end();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const wrapper of wrappers) wrapper.destroy();
  }
}
