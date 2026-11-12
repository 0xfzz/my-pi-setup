import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Provenance + geometry verification for the dashboard icon sprite.
 *
 * The dashboard does not ship a Phosphor dependency: the sprite in `index.html`
 * is a pinned copy of official Phosphor Regular geometry, and the exact source
 * assets live under `web/dashboard/icons/regular/`. These tests re-derive the
 * sprite from those assets so a hand-edited or approximated path cannot pass.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dashboard = join(root, "web", "core", "dashboard");

const indexHtml = readFileSync(join(dashboard, "index.html"), "utf8");
const styleCss = readFileSync(join(dashboard, "style.css"), "utf8");
const iconsMd = readFileSync(join(dashboard, "ICONS.md"), "utf8");
const licenseText = readFileSync(join(dashboard, "licenses", "phosphor-icons-MIT.txt"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type ManifestIcon = { symbol: string; name: string; file: string; sha256: string };
type Manifest = {
  package: string;
  version: string;
  weight: string;
  license: string;
  integrity: string;
  registry: string;
  attribution: string;
  icons: ManifestIcon[];
};

const manifest = JSON.parse(
  readFileSync(join(dashboard, "icons", "manifest.json"), "utf8"),
) as Manifest;

const PINNED_VERSION = "2.1.1";

/** The expected semantic mapping: dashboard key -> Phosphor regular asset. */
const EXPECTED: Record<string, string> = {
  manager: "briefcase",
  agent: "user-circle",
  spec: "file-text",
  review: "seal-check",
  folder: "folder",
  escalation: "warning-octagon",
  snippet: "code",
  node: "circle",
  close: "x",
  menu: "list",
  plus: "plus",
  minus: "minus",
  fit: "corners-out",
  legend: "info",
  list: "list-bullets",
  graph: "graph",
};

type SymbolInfo = { id: string; key: string; attrs: string; body: string; dataIcon?: string };

const spriteStart = indexHtml.indexOf('<svg class="icon-sprite"');
const spriteEnd = indexHtml.indexOf("</svg>", spriteStart) + "</svg>".length;
const sprite = indexHtml.slice(spriteStart, spriteEnd);

function parseSymbols(source: string): SymbolInfo[] {
  const out: SymbolInfo[] = [];
  for (const match of source.matchAll(/<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/g)) {
    const attrs = match[1];
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1] ?? "";
    out.push({
      id,
      key: id.replace(/^icon-/, ""),
      attrs,
      body: match[2].trim(),
      dataIcon: /\bdata-icon="([^"]+)"/.exec(attrs)?.[1],
    });
  }
  return out;
}

const symbols = parseSymbols(sprite);
const symbolById = new Map(symbols.map((symbol) => [symbol.id, symbol]));

function assetPath(icon: ManifestIcon): string {
  return join(dashboard, "icons", icon.file);
}

function assetText(icon: ManifestIcon): string {
  return readFileSync(assetPath(icon), "utf8");
}

function assetPathData(icon: ManifestIcon): string {
  const match = /<path d="([^"]+)"\s*\/>/.exec(assetText(icon));
  assert.ok(match, `${icon.file} has no single <path d>`);
  return match[1];
}

function symbolPathData(symbol: SymbolInfo): string {
  const match = /^<path d="([^"]+)"\s*\/>$/.exec(symbol.body);
  assert.ok(match, `${symbol.id} is not a single Phosphor <path>`);
  return match[1];
}

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

const refsInHtml = new Set(
  [...indexHtml.matchAll(/#icon-([a-z-]+)/g)].map((match) => `icon-${match[1]}`),
);

function referencesFromSource(relative: string): Set<string> {
  const source = readFileSync(join(dashboard, relative), "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(/\bicon\(\s*"([a-z-]+)"/g)) names.add(`icon-${match[1]}`);
  const glyphs = /KIND_GLYPHS\s*=\s*\{([\s\S]*?)\}/.exec(source);
  if (glyphs) {
    for (const match of glyphs[1].matchAll(/:\s*"([a-z-]+)"/g)) names.add(`icon-${match[1]}`);
    // The documented fallback glyph for an unknown node kind.
    const fallback = /KIND_GLYPHS\[kind\]\s*\|\|\s*"([a-z-]+)"/.exec(source)?.[1];
    if (fallback) names.add(`icon-${fallback}`);
  }
  return names;
}

test("vendored assets are byte-identical to the pinned Phosphor regular files", () => {
  assert.equal(manifest.package, "@phosphor-icons/core");
  assert.equal(manifest.version, PINNED_VERSION, "manifest must pin the Phosphor core version");
  assert.equal(manifest.weight, "regular");
  assert.equal(manifest.license, "MIT");
  assert.match(manifest.integrity, /^sha512-[A-Za-z0-9+/]+=*$/, "registry integrity must be recorded");
  assert.match(manifest.registry, /@phosphor-icons\/core\/-\/core-2\.1\.1\.tgz$/);
  assert.equal(manifest.icons.length, Object.keys(EXPECTED).length);

  for (const icon of manifest.icons) {
    const raw = readFileSync(assetPath(icon));
    assert.equal(
      sha256(raw),
      icon.sha256,
      `${icon.file} does not match the recorded sha256 (re-vendor from ${PINNED_VERSION})`,
    );
    // Upstream ships exactly one <svg> with one <path> and no styling beyond currentColor.
    assert.match(
      raw.toString("utf8"),
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 256 256" fill="currentColor"><path d="[^"]+"\/><\/svg>$/,
      `${icon.file} is not pristine Phosphor regular geometry`,
    );
  }
});

test("sprite symbols are official Phosphor geometry with native 256 viewBox", () => {
  assert.ok(sprite.length > 0, "index.html must contain the inline icon sprite");
  assert.equal(symbols.length, Object.keys(EXPECTED).length);
  assert.deepEqual(
    Object.fromEntries(symbols.map((symbol) => [symbol.key, symbol.dataIcon])),
    EXPECTED,
    "symbol ids and their Phosphor asset names must match the documented mapping",
  );

  for (const symbol of symbols) {
    assert.match(symbol.attrs, /\bviewBox="0 0 256 256"/, `${symbol.id} must use Phosphor's native viewBox`);
    assert.match(symbol.attrs, /\bfill="currentColor"/, `${symbol.id} must paint with currentColor`);
    const icon = manifest.icons.find((candidate) => candidate.symbol === symbol.id);
    assert.ok(icon, `${symbol.id} is missing from icons/manifest.json`);
    assert.equal(
      symbolPathData(symbol),
      assetPathData(icon),
      `${symbol.id} path is not the official ${icon.name} geometry`,
    );
  }
});

test("no inherited stroke geometry or legacy 24px drawing survives", () => {
  assert.doesNotMatch(sprite, /<circle\b/, "old hand-drawn circle geometry must be gone");
  assert.doesNotMatch(sprite, /stroke(-width|-linecap|-linejoin)?=/, "filled Phosphor glyphs must not inherit stroke");
  assert.doesNotMatch(sprite, /viewBox="0 0 24 24"/, "legacy 24px viewBox must be gone");
  assert.doesNotMatch(sprite, /\bfill="none"/, "Phosphor regular is a filled weight");
  assert.doesNotMatch(sprite, /\bstyle=|<style\b|\son[a-z]+=/i, "sprite must stay static markup (CSP-safe)");
  for (const symbol of symbols) {
    assert.match(symbol.body, /^<path d="[^"]+"\s*\/>$/, `${symbol.id} must contain exactly one filled path`);
  }
});

test("every icon reference resolves to a symbol", () => {
  const dynamicRefs = new Set([
    ...referencesFromSource("src/app.mjs"),
    ...referencesFromSource("src/graph.mjs"),
  ]);
  const refs = new Set([...refsInHtml, ...dynamicRefs]);

  for (const ref of refs) {
    assert.ok(symbolById.has(ref), `${ref} is referenced but has no <symbol>`);
  }
  // No dead symbols either: every vendored glyph is reachable from markup or model code.
  for (const id of symbolById.keys()) {
    assert.ok(refs.has(id), `${id} is defined but never referenced (index.html, src/app.mjs, src/graph.mjs)`);
  }
});

test("control ids, accessibility labels, graph swatches, CSP and π branding are preserved", () => {
  const controlIds = [
    "sidebar-close",
    "nav-toggle",
    "graph-zoom-out",
    "graph-zoom-in",
    "graph-fit",
    "legend-toggle",
    "drawer-close",
  ];
  for (const id of controlIds) {
    assert.match(indexHtml, new RegExp(`\\bid="${id}"`), `control #${id} must keep its id`);
  }
  const labels = [
    "Close sessions panel",
    "Open sessions panel",
    "Zoom out",
    "Zoom in",
    "Fit graph to view",
    "Toggle node and edge legend",
    "Close detail",
  ];
  for (const label of labels) {
    assert.ok(indexHtml.includes(`aria-label="${label}"`), `accessible label "${label}" must survive`);
  }
  // Decorative contract: every <use> sits inside an aria-hidden svg.
  for (const match of indexHtml.matchAll(/<svg class="icon"([^>]*)><use href="#icon-([a-z-]+)"\/><\/svg>/g)) {
    assert.match(match[1], /aria-hidden="true"/, `icon ${match[2]} must stay decorative`);
    assert.match(match[1], /focusable="false"/);
  }

  assert.ok(indexHtml.includes("Content-Security-Policy"), "CSP meta must remain");
  assert.ok(
    indexHtml.includes(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'none'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
    ),
    "CSP must be unchanged",
  );
  assert.ok(indexHtml.includes('<div class="brand-mark" aria-hidden="true">π</div>'), "π branding must remain");

  // Graph shape/edge swatches are semantic geometry, not icon replacements.
  for (const selector of [
    ".shape-swatch.kind-session",
    ".shape-swatch.kind-child",
    ".shape-swatch.kind-handoff",
    ".shape-swatch.kind-review",
    ".shape-swatch.kind-spec-review",
    ".shape-swatch.kind-escalation",
    ".line-swatch.edge-handoff",
    ".line-swatch.edge-verdict",
    ".line-swatch.edge-escalation",
  ]) {
    assert.ok(styleCss.includes(selector), `${selector} swatch styling must remain`);
  }

  // Icon sizing is the only styling change, and it stays in CSS with currentColor.
  assert.match(styleCss, /\.icon \{\s*width: 16px;\s*height: 16px;/, "standard control icons stay 16px");
  assert.match(styleCss, /\.icon-kind \{ width: 14px; height: 14px; \}/, "kind chip icons are 14px");
});

test("attribution records source, version, mapping and MIT license", () => {
  assert.ok(iconsMd.includes(PINNED_VERSION), "ICONS.md must name the pinned version");
  assert.ok(iconsMd.includes("MIT"), "ICONS.md must state the license");
  assert.ok(iconsMd.includes(manifest.integrity), "ICONS.md must record the registry integrity");
  for (const [key, name] of Object.entries(EXPECTED)) {
    assert.ok(iconsMd.includes(`icon-${key}`), `ICONS.md mapping must list icon-${key}`);
    assert.ok(iconsMd.includes(`\`${name}\``), `ICONS.md mapping must name ${name}`);
  }
  assert.match(licenseText, /^MIT License/, "license file must be the MIT text");
  assert.match(licenseText, /Copyright \(c\) 2023 Phosphor Icons/, "license file must carry the Phosphor notice");
  assert.equal(manifest.attribution, "../licenses/phosphor-icons-MIT.txt");
});

test("a real HTML parser resolves every <use> to a <symbol>", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(indexHtml, { contentType: "text/html" });
  const { document } = dom.window;

  const spriteEl = document.querySelector("svg.icon-sprite");
  assert.ok(spriteEl, "the sprite svg must parse");
  assert.equal(spriteEl.getAttribute("aria-hidden"), "true", "sprite must stay hidden from AT");
  assert.equal(spriteEl.getAttribute("width"), "0");
  assert.equal(spriteEl.getAttribute("height"), "0");

  const parsedSymbols = [...document.querySelectorAll("svg.icon-sprite symbol")];
  assert.equal(parsedSymbols.length, Object.keys(EXPECTED).length);
  for (const symbol of parsedSymbols) {
    const children = [...symbol.children];
    assert.equal(children.length, 1, `${symbol.id} must have exactly one path child`);
    assert.equal(children[0].tagName.toLowerCase(), "path");
    assert.ok((children[0].getAttribute("d") ?? "").length > 20, `${symbol.id} path data must not be empty`);
  }

  for (const use of document.querySelectorAll("use")) {
    const href = use.getAttribute("href") ?? "";
    assert.match(href, /^#icon-[a-z-]+$/, `unexpected icon reference ${href}`);
    assert.ok(document.querySelector(href), `${href} does not resolve inside the parsed document`);
  }
});


test("no runtime dependency, network fetch or external asset for icons", () => {
  const allDeps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.optionalDependencies,
  };
  assert.equal(
    Object.keys(allDeps).filter((name) => /phosphor/i.test(name)).length,
    0,
    "icons must not add a Phosphor package dependency",
  );
  // The only absolute URL allowed inside the sprite is the SVG namespace declaration.
  const spriteWithoutNs = sprite.replace(/\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "");
  assert.doesNotMatch(spriteWithoutNs, /https?:\/\//, "sprite must not reference a remote URL");
  assert.doesNotMatch(sprite, /\b(href|xlink:href)="(?!#)/, "symbol references must stay same-document");
  assert.doesNotMatch(sprite, /<image\b|<script\b|<foreignObject\b/i);
  assert.equal(/https?:\/\//.test(styleCss), false, "style.css must not fetch a remote icon");
});
