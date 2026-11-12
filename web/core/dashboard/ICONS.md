# Dashboard icons

The dashboard ships an inline SVG sprite in [`index.html`](./index.html). Every
symbol in it is an unmodified **Phosphor Regular** glyph. Nothing is fetched at
runtime: no icon font, no CDN, no React package, no build-time download, no new
npm dependency.

## Provenance

| Field | Value |
| --- | --- |
| Package | [`@phosphor-icons/core`](https://www.npmjs.com/package/@phosphor-icons/core) |
| Version (pinned) | `2.1.1` (current `latest` at time of vendoring) |
| Weight | `regular` |
| License | MIT — [Phosphor Icons](https://github.com/phosphor-icons/core), Copyright (c) 2023 |
| Registry tarball | `https://registry.npmjs.org/@phosphor-icons/core/-/core-2.1.1.tgz` |
| Tarball integrity | `sha512-v4ARvrip4qBCImOE5rmPUylOEK4iiED9ZyKjcvzuezqMaiRASCHKcRIuvvxL/twvLpkfnEODCOJp5dM4eZilxQ==` |
| Upstream repository | `https://github.com/phosphor-icons/core` (assets under `assets/regular/<name>.svg`) |

License text: [`licenses/phosphor-icons-MIT.txt`](./licenses/phosphor-icons-MIT.txt).

The 16 source assets are vendored byte-for-byte under
[`icons/regular/`](./icons/regular), with per-file SHA-256 digests in
[`icons/manifest.json`](./icons/manifest.json). The manifest is the single source
of truth for provenance; the sprite is verified against it by
`tests/dashboard-icons.test.ts`.

## Mapping

Semantic symbol ids are unchanged, so `web/dashboard/src/app.mjs::icon()` and
`graph.mjs::kindGlyph()` keep their call sites.

| Symbol id | Phosphor Regular asset | Used for |
| --- | --- | --- |
| `icon-manager` | `briefcase` | session / manager node, session kind chip |
| `icon-agent` | `user-circle` | child agent node, agent kind chip |
| `icon-spec` | `file-text` | handoff spec node, artifact "Spec" chip |
| `icon-review` | `seal-check` | review node |
| `icon-folder` | `folder` | spec-review (gate) node |
| `icon-escalation` | `warning-octagon` | escalation node and banner |
| `icon-snippet` | `code` | artifact node and "Artifact" chip |
| `icon-node` | `circle` | unknown/fallback node kind |
| `icon-close` | `x` | close buttons (sidebar, drawer) |
| `icon-menu` | `list` | sessions panel toggle |
| `icon-plus` | `plus` | graph zoom in |
| `icon-minus` | `minus` | graph zoom out |
| `icon-fit` | `corners-out` | fit graph to view |
| `icon-legend` | `info` | legend toggle |
| `icon-list` | `list-bullets` | work "List" view segment |
| `icon-graph` | `graph` | work "Graph" view segment |

Graph node shapes and the legend's shape/line swatches are semantic geometry
(circle, rounded rect, seal outline, dotted edges). They are deliberately *not*
icon replacements.

## Adaptation applied

Only what an inline sprite requires; no path data is edited:

* `<svg viewBox="0 0 256 256" fill="currentColor">` becomes
  `<symbol id="…" data-icon="…" viewBox="0 0 256 256" fill="currentColor">`,
  keeping Phosphor's native 256×256 coordinate space.
* The outer `<svg xmlns="…">` wrapper is dropped (the sprite `<svg>` already
  declares the namespace inside an HTML document).
* `data-icon` records the upstream asset name for verification.
* Everything else — the single `<path d="…">` per icon, `fill="currentColor"` —
  is carried over exactly. No `stroke`, `stroke-width`, `stroke-linecap` or
  `stroke-linejoin` remains: Phosphor Regular is a filled (solid) weight, so
  inheriting stroke geometry from the old hand-drawn sprite would distort it.

Sizing lives in CSS (`style.css`, `.icon` / `.icon-kind`), not in the sprite, so
`currentColor` and the existing `aria-hidden` decorative contract are preserved.

## Verifying

```sh
node --experimental-strip-types --import ./tests/isolate-env.mjs \
  --test tests/dashboard-icons.test.ts
```

The test re-reads each vendored SVG, extracts its path, and asserts:

1. every sprite symbol's `d` is byte-identical to the vendored asset, with
   `viewBox="0 0 256 256"` and `fill="currentColor"`;
2. every manifest digest matches the file on disk and the pinned version;
3. no symbol carries stroke geometry or a legacy `0 0 24 24` viewBox;
4. every `#icon-*` reference in `index.html` (and every `kindGlyph` name in
   `src/graph.mjs`) resolves to a symbol;
5. CSP, control ids, aria labels and π branding are intact.

## Regenerating / upgrading

1. `npm pack @phosphor-icons/core@<version>` in a scratch directory (never add it
   to this project's dependencies), then extract the tarball.
2. Copy the 16 files listed above from `package/assets/regular/` into
   `icons/regular/` unchanged.
3. Update `icons/manifest.json` (`version`, `integrity`, per-file `sha256`).
4. Re-apply the symbol adaptation described above in `index.html`.
5. Update this table if the icon names change, then run the test command.
