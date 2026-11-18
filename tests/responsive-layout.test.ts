import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { COMPACT_VIEWPORT_WIDTH, SHORT_LANDSCAPE_HEIGHT, isCompactViewport } from "../web/core/shared/responsive.ts";

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const baseCss = source("../web/core/client/base.css");
const pluginsCss = source("../web/core/client/plugin-system/plugins.css");
const filesCss = source("../web/plugins/files/files.css");
const routerCss = source("../web/plugins/router/router.css");
const shell = source("../web/core/client/shell.tsx");

test("compact viewport policy uses one shared width and short-landscape height", () => {
  assert.equal(COMPACT_VIEWPORT_WIDTH, 720);
  assert.equal(SHORT_LANDSCAPE_HEIGHT, 500);
  assert.equal(isCompactViewport(390, 844, "portrait"), true);
  assert.equal(isCompactViewport(844, 390, "landscape"), true);
  assert.equal(isCompactViewport(1024, 768, "landscape"), false);
  assert.equal(isCompactViewport(721, 390, "landscape"), true);
});

test("shell delegates responsive decisions to the shared policy", () => {
  assert.match(shell, /isCompactViewport\(/);
  assert.doesNotMatch(shell, /window\.innerWidth\s*>\s*720/);
  assert.doesNotMatch(shell, /window\.innerWidth\s*<=\s*720/);
});

test("CSS declares width and short-landscape breakpoints matching the shared constants", () => {
  const width = `(max-width: ${COMPACT_VIEWPORT_WIDTH}px)`;
  const height = `(max-height: ${SHORT_LANDSCAPE_HEIGHT}px) and (orientation: landscape)`;
  for (const css of [baseCss, pluginsCss]) {
    assert.match(css, new RegExp(width.replace(/[()]/g, "\\$&")));
    assert.match(css, new RegExp(height.replace(/[()]/g, "\\$&")));
  }
  assert.match(routerCss, /\(pointer: coarse\)/);
});

test("bottom sheets never use bare 100vw and fixed overlays follow the visual viewport", () => {
  assert.doesNotMatch(baseCss, /width:\s*100vw\s*;/);
  assert.match(baseCss, /\.app-dialog-backdrop[\s\S]*?--app-viewport-top/);
  for (const selector of [".app-sidebar-wrap", ".app-sidebar-scrim", ".app-custom-popups", ".app-toasts"]) {
    const block = new RegExp(`${selector}\\s*\\{[^}]*--app-viewport-(top|height)`);
    assert.match(baseCss, block, selector);
  }
  const scrim = new RegExp(".app-side-panel-scrim\\s*\\{[^}]*--app-viewport-(top|height)");
  assert.match(pluginsCss, scrim, ".app-side-panel-scrim");
  const filesPanel = new RegExp(".app-side-panel\\.files-panel\\s*\\{[^}]*--app-viewport-(top|height)");
  assert.match(filesCss, filesPanel, ".app-side-panel.files-panel");
});

test("coarse pointers get 44px targets, 16px inputs and readable minimum type", () => {
  assert.match(baseCss, /@media\s*\(pointer: coarse\)/);
  assert.match(baseCss, /\.app-composer-row button[\s\S]{0,800}min-height:\s*44px/);
  assert.match(baseCss, /\.app-session-item[\s\S]{0,800}min-height:\s*44px/);
  assert.match(baseCss, /font-size:\s*16px/);
  assert.match(baseCss, /font-size:\s*12px/);
  assert.match(routerCss, /\.router-canvas-toolbar button[\s\S]{0,160}min-height:\s*44px/);
});
