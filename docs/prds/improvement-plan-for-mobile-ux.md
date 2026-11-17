# PRD: Mobile UX audit and improvement plan for pi-web

> Part of [pi-workflow-extensions](../../README.md). Audit of the first-party `web/` client from a phone perspective, with a prioritized remediation plan.

| Field | Value |
| --- | --- |
| **Status** | proposed — ready for implementation planning |
| **Owner** | Faiz |
| **Scope** | `web/core/client/**`, `web/plugins/**`, `web/core/server/client-static.ts`; the running pi-web app at `http://127.0.0.1:30142/` |
| **Goal** | Make every screen, panel, dialog, page and viewer usable with one thumb on a 320–430 px phone, in portrait and short landscape, with a soft keyboard open |
| **Method** | Live browser audit + read-only source audit; see §2 |

## 1. Executive summary

The shell is already mobile-aware: the session list becomes a scrim drawer, side panels become overlays, dialogs become bottom sheets, code blocks scroll locally, reduced-motion is respected, and document-level horizontal overflow is absent at every width tested. The failure is not "no responsive design" — it is **mobile detail debt**.

Three things dominate the experience:

1. **Everything is too small to hit.** Header controls are 30×30 px, composer attach/send are 36×36 px, the model chip is 21 px high, router tools are 28×28 px, artifact rows are ~34 px, and many plugin actions are 18–33 px. The coarse-pointer CSS raises some dialog rows to 44 px but stops at the dialog boundary.
2. **Dialogs and sheets do not adapt to a real phone keyboard.** The settings dialog squeezes its label column to ~31 px and scrolls horizontally; the new-session sheet clips its actions when the visual viewport shrinks; several inputs stay below 16 px and will zoom iOS Safari on focus.
3. **Secondary surfaces were built at desktop widths.** The MCP form's Save/Cancel sit under the bottom navigation, the router graph is downscaled to ~0.69× in a phone panel, the ACL/metadata text in artifact rows collapses, and the plugin-manager route linked from every plugin page is broken.

No P0 blocks the main chat flow. One P0 navigation bug was found outside the chat: the **Plugins** page link returns `{"error":"not found"}` because the SPA fallback refuses paths with a dot in them.

## 2. Audit method and coverage

### 2.1 Viewports and inputs

| Viewport | Result |
| --- | --- |
| 390×844 | Primary phone audit. `document.documentElement.scrollWidth === 390`. |
| 320×568 | Narrow-phone check. `scrollWidth === 320`; header/title still fit but controls remain 30 px. |
| 844×390 | Short landscape. `scrollWidth === 844`; JS treats it as "wide" (`>720`), so docked panels mount with only ~173 px of transcript height. |
| Keyboard / notch | Not reproducible in desktop Playwright. Assessed from `use-visual-viewport.ts`, safe-area CSS and component structure; marked **S** in findings. |
| Coarse pointer | The browser used for the live run did not report `(pointer: coarse)`. Touch-specific copy exists in source; tap-target measurements are the raw CSS box sizes and therefore represent the worst case. Marked **L/S** where both live measurement and source agree. |

Evidence frames were captured for the main chat, session drawer, settings dialog, Files preview and Router panel under the `mobile-ux-audit` browser checklist.

### 2.2 Surfaces probed

| Surface | How it was reached | Status |
| --- | --- | --- |
| Main chat: header, transcript, tool blocks, composer, context/hint strip | Live, 390/320/844 widths | L |
| Session drawer: search, session list, theme, sign out | Live hamburger; 232 px overlay + scrim | L |
| New-session bottom sheet: recents, path browse, directory list, Start session | Live; sheet opened, browse expanded | L |
| More panels menu: pins, unavailable pins, all plugin entries | Live; 360×571 menu | L |
| Generic side panel (Delegated work, Subagent graph, Input mode, etc.) | Live; 343 px drawer | L/S |
| Todo panel | Live; 6 task rows | L |
| Artifacts panel (empty state in the live session) | Live + source for catalog/preview | L/S |
| Files panel: browser, search, breadcrumbs | Live; directory list | L |
| File preview and embedded document viewer | Live; `AGENTS.md`, rendered/source modes | L/S |
| Router graph panel | Live; 28 px tools, touch-inappropriate hint | L |
| MCP servers page + Add server form | Live; form actions overlapped by bottom nav | L |
| Plugins page | Live — **broken route** | L |
| Model / provider / router settings dialog | Live via `/model`; tabs, search, 158 models | L |
| Thinking picker | Live via `/thinking` | L |
| Settings dialog | Live via `/settings`; horizontal scroll defect | L |
| Scoped models | Live via `/scoped-models` | L |
| Project trust | Live via `/trust` | L |
| Login / Logout | Live via `/login`, `/logout` | L |
| Session info, Web keybindings, Info dialogs | Live via `/session` and `/hotkeys`; changelog/info path reviewed in shell source | L/S |
| Tree selector | Live via `/tree`; 4775 rows, filter, footer hint | L |
| Extension-published `PluginDialog` | Source review (dynamic per session) | S |
| Ask-user, provider wizard, router editor dialogs | Source review (extension-published, not live in this session) | S |
| Toasts, reload/prompt banners, editor widgets, custom popups | Live shell + source review | L/S |
| Auth gate | Source review (not active on this loopback instance) | S |
| Composer override region, plugin slots/anchors | Source review | S |

Legend: **L** = observed in the live app; **S** = established from source; **L/S** = both. "All screens" means every rendered surface enumerated in `web/core/client` and `web/plugins`; views requiring a specific session state (populated artifacts, active child agents, published extension dialogs) were additionally reviewed in source because they could not be forced without mutating a live agent session.

### 2.3 Subagent reviews

Two read-only source reviews were accepted and cross-checked:

- `report-css-layout-audit-2` — every media/coarse-pointer/safe-area rule in `base.css`, `plugins.css`, `router.css`; 18 findings.
- `report-plugin-ui-audit-2` — every plugin component, panel, page, popup, new-session dialog and auth gate; 20+ findings.

Their remediation plans informed §5. All cited line references in this document were spot-checked against the working tree.

## 3. Findings by surface

Severity: **P0** blocks a reachable flow; **P1** materially breaks phone usability; **P2** degrades quality, accessibility or edge cases.

### 3.0 Cross-cutting / navigation

| ID | Sev | Finding | Evidence | Direction |
| --- | --- | --- | --- | --- |
| X1 | **P0** | The **Plugins** page link navigates to `/plugins/core.plugin-manager` and returns raw JSON `{"error":"not found"}` instead of the plugin manager page. Same for direct navigation. | Descriptor path at `web/plugins/plugin-manager/descriptor.ts:12`; link built by `web/core/client/plugin-system/PluginLayout.tsx:14-17`; SPA fallback skips paths with `extname()` at `web/core/server/client-static.ts:81`. Live: clicking "Plugins" from MCP page lands on the JSON 404. | Allow known dotted plugin ids through the SPA fallback (or move plugin page paths to extensionless slugs) and add an e2e assertion. |
| X2 | P1 | Breakpoint drift: JS switches shell panels at `innerWidth > 720`, while CSS uses 720, 767, 641 and 480. At 721–767 px the desktop panel layout and narrow-only overlay rules coexist. | `web/core/client/shell.tsx:68-70,131-142,544-549`; `plugins.css:529,820,944,967,2148`; `base.css:512,2576` | One exported breakpoint used by both JS and CSS. |
| X3 | P1 | No short-height/orientation handling. At 844×390 the docked layout mounts; measured header 54 px, transcript 173 px, composer 163 px. | Live measurement; `shell.tsx:68-70` | Force overlay mode and collapse chrome under `(max-height: 500px) and (orientation: landscape)`. |
| X4 | P1 | Fixed overlays (sidebar scrim, side-panel scrim, toasts, custom popups) use `top:0`/`inset:0` instead of the visual-viewport variables; they desync from the root and dialog backdrop when the mobile keyboard or address bar changes the visual viewport. | `base.css:78-84,1291-1300`; `plugins.css:829-845`; `use-visual-viewport.ts:8-22` | Anchor every fixed surface to `--app-viewport-top/height` plus safe-area insets. |
| X5 | P1 | No left/right safe-area padding on bottom sheets; `width:100vw` can exceed the visual viewport on notched phones. | `base.css:2582-2589` | `width:100%; padding-inline: max(14px, env(safe-area-inset-left/right))`. |
| X6 | P2 | Nested scroll chains: files body + files list, artifacts panel + preview body, dialog list + sheet. Touch scrolling can chain into the transcript. | `plugins.css:760-763,1361-1368`; `base.css:83,611` | One scroll owner per surface; `overscroll-behavior: contain`. |
| X7 | P2 | Small text: 9–11 px labels, timestamps, router hints and dialog hints. | `router.css:4,22-23`; `base.css:1061-1075,2550`; `dialogs.tsx:1333` | Raise minimum UI text to ~12 px on narrow/coarse surfaces. |

### 3.1 Main chat

| ID | Sev | Finding | Evidence | Direction |
| --- | --- | --- | --- | --- |
| C1 | P1 | Header icon buttons are 30×30 px, composer attach/send 36×36 px, model chip 21 px high. Below the 44 px touch target used elsewhere in the app; at 320 px four header controls plus gaps leave little room for the project title (status/caption are already hidden). | Live at 390 and 320: measured `{Toggle session list, Cache health, Todo, Artifacts, More panels} = 30×30`, `{Attach images, Send message} = 36×36`, model chip `96×21`; `plugins.css:820-827,2677-2680`. | Coarse/narrow override to ≥44 px hit boxes; overflow secondary panel icons into one menu below ~400 px. |
| C2 | P1 | The session drawer covers its own toggle: clicking "Toggle session list" while the drawer is open fails because the drawer's title intercepts pointer events. Only the scrim closes it. | Live: Playwright click timed out with `<span class="app-title">pi</span> … intercepts pointer events`. | Add an explicit labelled close control inside the drawer and/or place it above the drawer z-index. |
| C3 | P1 | Tool blocks and transcript text are readable but code blocks own a horizontal scrollbar at 320 px; at short landscape a 320 px code block occupies most of the 173 px transcript. | Live code-block scrollbar; `base.css:856-866,2204-2223` | Cap to `min(320px, 40dvh)` and contain overscroll. |
| C4 | P2 | Composer consumes 150 px at 320×568 and 163 px at 844×390; meta chips, workspace line and hint persist when space is scarce. | Live; `base.css:2343-2353,2423-2441,2532-2554` | Collapse hint/workspace/meta under short visual viewports while keeping send/stop reachable. |
| C5 | P2 | `aria-live="polite"` wraps the whole transcript, so streaming can announce large blocks. | `transcript.tsx:644` | Scope live announcements to the streaming message/status. |
| C6 | P2 | Tool-call buttons inherit entire shell commands as accessible names (one measured button name was a multi-paragraph `git commit` command), polluting screen-reader and test locators. | Live `getByRole` strict-mode error contained full shell command text; `transcript.tsx` tool header | Give a short `aria-label` such as "bash tool call" and move details to a description. |
| C7 | P2 | Desktop hint "Shift+Enter for a new line" is rendered in the automated browser. Source has a coarse-pointer swap to "Return", so real phones should be fine — verify on device. | `composer.tsx:616-618`; `base.css:2561` | Device-check; if the media query misses hybrid devices, key off touch capability, not width alone. |
| C8 | P2 | Toasts sit bottom-right without safe-area padding and below the 55 z-index side-panel scrim. | `popups.tsx:36-39`; `base.css:1958-1962`; `plugins.css:841-846` | Safe-area-aware bottom, raise above scrims or suppress while a panel is open. |

**Already working:** no document-level horizontal overflow at any audited width; local scrolling for code/diffs; jump-to-latest behaviour; reduced-motion rules; status chips hidden on phones; touch Enter handling in the composer.

### 3.2 Sessions and new-session sheet

| ID | Sev | Finding | Evidence | Direction |
| --- | --- | --- | --- | --- |
| S1 | P1 | Recent projects show only the basename (`pi-workflow-extensions`, `ruumi-dev`, `x`); duplicate names are indistinguishable on touch because the full path is `title`-only. | `new-session-dialog.tsx:111-118`; live sheet | Show parent path or wrap the full path. |
| S2 | P1 | Path input is 12 px (iOS zoom risk); Browse/Up/Start are 24–33 px; the 16 px coarse rule omits `.app-dialog-path-input`. | `new-session-dialog.tsx:128-146,155-163,189-196`; `base.css:1810-1837,2661-2665`; live `Start session` measured 33 px high. | 16 px input, 44 px buttons. |
| S3 | P1 | The sheet height-caps the container but only the directory list scrolls; with a keyboard on a 568 px phone, header/actions can be clipped. | `base.css:2581-2589,1899-1907`; `new-session-dialog.tsx:92-98,153-185` | Make the sheet one scroll owner with sticky header/actions. |
| S4 | P2 | Session titles in the 232 px drawer are truncated to ~17 characters. | Live drawer | Two-line clamp or show more of the name; keep the ID as secondary. |
| S5 | P2 | Close X and directory rows in the new-session sheet are small; browse toggles an inline list with no visible state change label. | Live | 44 px targets and an explicit expanded/collapsed label. |

### 3.3 Dialogs and sheets

| ID | Sev | Finding | Evidence | Direction |
| --- | --- | --- | --- | --- |
| D1 | P1 | **Settings dialog is broken at phone width**: labels squeeze to ~31 px ("Th e" / "lev el"), option chips clip, and the list has a horizontal scrollbar (`scrollWidth 379` vs `clientWidth 347`). | Live at 390×844; `base.css:2576-2626` stacks columns but leaves fixed row internals. | Stack each setting as label/description/control at ≤480 px; `min-width:0` on all children; no horizontal scroll. |
| D2 | P1 | `DialogFrame`-based dialogs have no visible close button. Touch users only get backdrop tap or Escape; footers literally say "esc close". | `dialogs.tsx:140-158` vs `SidebarDialog` at `dialogs.tsx:83-89`; live Model/Thinking/Settings/Trust dialogs | Add a labelled close X in `DialogFrame`, focused on open. |
| D3 | P1 | Dialogs declare `role="dialog" aria-modal="true"` but are siblings after the shell; no focus trap, `inert`, or focus return. | `dialogs.tsx:76,146,1579`; `shell.tsx:788-791` | Trap focus, mark background inert, restore focus on close. |
| D4 | P1 | Keyboard-shrunk sheets can clip content: height is 92% of a 220 px visual viewport (~180 px), but header + tabs + search + list + 44 px actions exceed that and `.app-dialog-body` has no scroll escape. | `base.css:2586,1306-1323,1899-1902,2642-2656` | Scrollable sheet body; relax `min-height:120px` in short-viewport rules. |
| D5 | P2 | Model picker rows are ~44 px and well laid out, but tab labels and provider metadata are tiny; no model details are shown on the phone. | Live `/model` dialog | Raise type size; consider a detail sheet for the selected model. |
| D6 | P2 | Tree selector rows are ~24 px with long text truncated; footer says "type to filter" with no visible filter affordance on touch beyond the input. | Live `/tree`; `base.css:1029-1035` | 44 px rows on coarse pointers, clearer filter state. |
| D7 | P2 | Trust/Login/Logout/Info/Kbindings sheets fit the width but their footers and long rows rely on small text. | Live command sweep | Raise minimum font and row padding on coarse surfaces. |

**Well covered:** bottom-sheet geometry, tab wrapping, horizontally scrollable settings nav, stacked actions, 40–44 px coarse targets for dialog rows/actions, and the close X on `SidebarDialog` (model settings) all exist — the gaps are consistency and keyboard behaviour.

### 3.4 Plugin panels and pages

| ID | Sev | Finding | Evidence | Direction |
| --- | --- | --- | --- | --- |
| P1 | P1 | Router graph is laid out at a fixed 360×48 px node scale and fitted into a 281–343 px panel: targets become ~33 px high and 9 px provider text ~6 px. Tools are 28×28 px; hint says "scroll to zoom" and `touch-action:none` blocks native pinch without a pinch handler. | Live: 28×28 tools, 207×67 node, hint text; `routing-layout.ts:34,38-47`; `use-routing-viewport.ts:34-43`; `router.css:7-10` | Phone-specific vertical layout or guarded minimum effective scale; pinch gestures; 44 px tools; touch copy. |
| P2 | P1 | Files panel has two scroll owners (body + list) and no bottom safe-area padding. Its fullscreen control **does** work on phones (live: 390 px full width → 343 px drawer at x=47 after "Exit full screen"), but the resulting 88vw drawer leaves only a 47 px chat strip. | `plugins.css:760-763,831-838,1194-1200,1206-1211`; `FilesPanel.tsx:20,44,51-60`; live toggle measurement | One scroll owner, safe-area padding, and a non-fullscreen width that leaves a usable companion strip; keep the working toggle. |
| P3 | P1 | Artifact catalog rows are ~34 px with `nowrap` metadata; long titles collapse at 281 px. Preview's back/copy/rendered/source buttons are 26–28 px. | `ArtifactCatalog.tsx:31-42`; `ArtifactPreview.tsx:48,59-78,91-104`; `plugins.css:1672-1717,1746-1751,1812-1824,1850-1856` | 44 px rows/actions; wrap metadata below title. |
| P4 | P1 | MCP page: Edit/Remove/override/enable controls ~30 px; Add-server form has 12.5 px inputs, autofocus, and Save/Cancel at y=787 while the bottom nav starts at y=801 — a 19 px overlap. | Live form measurement; `McpManagerPage.tsx:184-238,270,283-302`; `plugins.css:1979-1991,2117-2127` | Drop phone autofocus, 16 px inputs, sticky actions above nav, 44 px controls. |
| P5 | P1 | Plugin-manager safe-mode banner can overflow at 320 px; Grant is ~18 px; lifecycle/Refresh actions ~32 px; audit `<summary>` rows have no touch sizing. | `PluginManagerPage.tsx:108-119,131-133,176-185,200-209,243-245`; `plugins.css:2208-2215,2233-2246,2355-2363,2387-2396,2408-2412` | Wrapping block layout; 44 px operator actions and audit rows. |
| P6 | P1 | Generic plugin views: KV labels `nowrap` squeeze values in a ~233 px area; list/graph toggles have 4×2 px padding; confirmation input `min-width:220px` overflows a ~202 px card; dialog-only views render blank. | `PluginViewRenderer.tsx:127-137,217-225,254-263,294-296`; `PluginActions.tsx:127-136`; `plugins.css:117-145,282-293,978-1013` | Stack KV rows, 44 px toggles, `min-width:0`, show a "respond in dialog" placeholder. |
| P7 | P2 | MCP page header subtitle is truncated to "Setup and manage…"; bottom nav wraps "Composer override" to a second line with ~31 px links. | Live MCP page at 390 px; `PluginLayout.tsx:45-56` | Two-line clamp for subtitle; wrapped/44 px nav links. |
| P8 | P2 | File metadata truncates to `AGENTS_...`; breadcrumbs scroll horizontally without an affordance; clear-search is a bare 14 px icon; embedded viewer toolbar buttons are 32 px (28 px compact). | Live Files preview; `FilePreview.tsx:98,103`; `FileBrowser.tsx:114-130,163-170`; `DocumentViewer.tsx:22-27,45-52`; `plugins.css:1340-1349` | Wrap/copyable path; visible affordance; 44 px clear and viewer-toolbar targets. |
| P9 | P2 | Search shows "No matching files" while the debounced request is still pending. | `FileBrowser.tsx:161-162,196-198` | Pending state. |
| P10 | P2 | Plugin page nav links and launcher rail/header buttons are 30–31 px; shortcut toast truncates with ellipsis. | `panel-launcher.tsx:100-110`; `PluginLayout.tsx:45-56`; `PluginActionShortcuts.tsx:87-95`; `plugins.css:788-802,1028` | 44 px targets; wrap toast. |
| P11 | P2 | `listbox` roles wrap plain buttons without `role="option"`/`aria-selected`. | `FileBrowser.tsx:184,204`; `ArtifactCatalog.tsx:26` | Correct option semantics or drop listbox role. |
| P12 | P2 | `window.confirm` is used for MCP server deletion — a browser-owned dialog with no app layout or focus treatment. | `McpManagerPage.tsx:224` | In-app accessible confirmation. |
| P13 | P2 | The side-panel Escape handler ignores `defaultPrevented`, so nested overlays can close together. | `PluginSidePanel.tsx:38-45` | Guard like Files/Artifacts do. |

### 3.5 Auth gate and popups

| ID | Sev | Finding | Evidence | Direction |
| --- | --- | --- | --- | --- |
| A1 | P1 | Auth password input inherits 14 px (iOS zoom); Sign in is ~35 px; input autofocuses on load, raising the keyboard over the centred card. | `auth-gate.tsx:40-42,75-85,92-94`; `base.css:3153-3176` | 16 px input, no autofocus on phones, 44 px button. |
| A2 | P2 | Custom popup is `role="dialog"` labelled only by a method name, with no `aria-modal`, focus management or close control; widget previews have no max-height. | `popups.tsx:71-90`; `base.css:2019-2065` | Proper modal semantics, close/focus return, max-height. |
| A3 | P2 | Prompt/reloading banners lack safe-area padding; prompt banner lacks `aria-live`. | `popups.tsx:101-115`; `base.css:2092-2114` | Add live region and safe-area padding. |

## 4. Design direction

### 4.1 Mobile interaction contract

1. **44 px minimum hit area** for every interactive control on coarse pointers or ≤720 px. The visual glyph may stay smaller; padding provides the target.
2. **One scroll owner per surface.** Panels and sheets scroll once; nested code/list areas use `overscroll-behavior: contain`.
3. **Keyboard-safe by default.** Every fixed surface reads `--app-viewport-top/height`; every sheet can shrink and scroll; primary actions stay visible or sticky; text inputs compute to ≥16 px.
4. **Safe-area aware.** Respect left/right/top/bottom insets; never use bare `100vw` for a sheet.
5. **Touch language.** No "scroll to zoom", "Shift+Enter" or "esc close" as the only instruction on a touch surface.
6. **Readable before compact.** Prefer wrapping and stacking over truncation; tooltips (title attributes) do not exist on touch.
7. **Genuine modals.** Visible close, focus trap, focus return, background inert.

### 4.2 Suggested information architecture changes

- **Header:** one overflow menu below ~400 px instead of four 30 px icons; keep session toggle and one primary panel action.
- **Composer:** collapse workspace/meta/hint when the visual viewport is short; keep attach and send/stop at 44 px.
- **Drawers:** full-width below 480 px; add an in-drawer close button; never leave only a 38 px strip of chat visible.
- **Plugin pages:** single-column cards; sticky Save/Cancel above the bottom nav; wrap operator banners.
- **Router:** vertical touch graph (hub on top, model pills stacked) instead of scaling the desktop fan-out.

## 5. Improvement plan

Each phase is one coherent, revertible commit per [AGENTS.md](../../AGENTS.md): `npm run tidy` must pass and the commit message must be scoped conventionally.

### Phase 0 — unblock plugin navigation (P0)

- Fix the SPA fallback so dotted plugin ids reach the client shell: `web/core/server/client-static.ts:81` must not treat `.plugin-manager` as a static asset extension; alternatively migrate page paths to extensionless slugs in `web/plugins/*/descriptor.ts`.
- Add a regression test that `GET /plugins/core.plugin-manager` returns HTML containing the app shell, and an e2e check that clicking **Plugins** in the page nav renders the plugin manager.
- **Acceptance:** both direct navigation and the in-app link render the page; `npm run tidy` passes.

### Phase 1 — shared responsive foundation (P1)

Files: `web/core/client/shell.tsx`, `use-visual-viewport.ts`, `base.css`, `plugin-system/plugins.css`, `router/router.css`.

- Export one breakpoint and a `isCompactViewport` state; use it for both JS panel mode and CSS rules.
- Add short-landscape rules (`max-height:500px and orientation:landscape`): overlay drawers, compact header/composer, no docked side panel.
- Anchor all fixed overlays to the visual viewport variables and safe-area insets; replace bottom-sheet `100vw` with `100%` + inline safe-area padding.
- Make sheet bodies scrollable and relax minimum list heights when the visual viewport is under ~300 px.
- Raise base typography and code-block caps; add overscroll containment.
- Align plugin CSS breakpoints; full-width phone drawers; 16 px coarse inputs everywhere; 44 px panel/router controls.
- **Acceptance:** at 320×568, 390×844, 844×390 and a simulated 220 px visual viewport, no document-level horizontal scroll, every fixed overlay aligns with the visible frame, all sheet content is reachable, and computed hit areas for audited chrome controls are ≥44 px (40 px only where explicitly documented compact chrome).

### Phase 2 — dialogs, sheets and modal semantics (P1)

Files: `web/core/client/dialogs.tsx`, `shell.tsx`, `new-session-dialog.tsx`, `auth-gate.tsx`.

- Add a labelled close button to `DialogFrame`; focus it on open.
- Trap focus, mark background `aria-hidden`/`inert`, restore focus to the trigger on close.
- Rebuild settings rows as stacked label/description/control at ≤480 px; remove horizontal scrolling.
- Make the new-session sheet one scroll owner with sticky header/actions; show distinguishable recent-project paths; 16 px path input; 44 px Browse/Up/Start.
- Remove phone autofocus in auth gate and MCP form; 16 px password input; 44 px Sign in.
- Dismiss orientation copy: replace "esc close" with a close button plus optional hint.
- **Acceptance:** every `DialogFrame` dialog has a visible close; keyboard focus stays inside; Settings, New session and Auth have no clipped or horizontally scrolling controls at 320 px and with a 220 px visual viewport.

### Phase 3 — core shell ergonomics and semantics (P1/P2)

Files: `web/core/client/composer.tsx`, `components/ui/button.tsx`, `sidebar.tsx`, `transcript.tsx`, `popups.tsx`.

- 44 px header, composer, sidebar and tree-row hit areas.
- In-drawer close control; fix the intercepted toggle.
- Scope transcript `aria-live`; short `aria-label`s for tool blocks.
- Compact composer on short visual viewports without losing textarea/attach/send.
- Safe-area-aware, correctly layered toasts and banners; custom popup modal semantics.
- **Acceptance:** computed target sizes, live-region scope and focus order verified at 390×844 and 320×568; touch Enter still inserts a newline; `npm run tidy` passes.

### Phase 4 — plugin surface pass (P1/P2)

Files: `web/plugins/files/*`, `web/plugins/artifacts/*`, `web/plugins/mcp-manager/McpManagerPage.tsx`, `web/plugins/plugin-manager/PluginManagerPage.tsx`, `web/plugins/router/*`, `web/core/client/plugin-system/*`.

- Files: one scroll owner, safe area, pending search state, 44 px clear target, recoverable full path, listbox semantics, 44 px embedded viewer toolbar, and a non-fullscreen width that leaves a usable companion strip (keep the working fullscreen toggle).
- Artifacts: 44 px rows/actions, wrapping metadata and tags, single scroll owner.
- MCP/Plugin manager: 16 px inputs, no phone autofocus, sticky actions above nav, wrapping banner, 44 px operator/audit-summary controls, in-app confirmation.
- Router: touch layout/pinch, 44 px tools, ≥12 px effective labels, touch-specific hint.
- Generic views/actions/launcher/page: stack KV rows, 44 px toggles/actions/nav, `min-width:0`, dialog-only placeholder, correct Escape guard, wrapping toast.
- **Acceptance:** at 320 px and 430 px every audited control is ≥44 px, no container clips text to an unreadable ellipsis, the MCP Save/Cancel are not covered by the nav, and the router graph remains legible/tappable after fitting.

### Phase 5 — regression guard (P2)

- Add `web/core/client/responsive-layout.test.ts` (or a Playwright viewport spec) asserting: one shared breakpoint, at least one height/orientation query, safe-area usage on all fixed surfaces, no bare `100vw` sheets, and coarse 44 px overrides for the audited selectors.
- Keep the browser evidence checklist as the manual QA script for 320×568, 390×844 and 844×390.
- **Acceptance:** the test fails if a second literal breakpoint or a bare fixed overlay is reintroduced; `npm run tidy` passes.

## 6. Verification matrix

| Check | 320×568 | 390×844 | 844×390 | Keyboard 220 px |
| --- | --- | --- | --- | --- |
| No document horizontal overflow | Phase 1+ | Phase 1+ | Phase 1+ | Phase 1+ |
| All primary actions ≥44 px | Phase 1+ | Phase 1+ | Phase 2+ | Phase 2+ |
| Sheet content reachable, close visible | Phase 2 | Phase 2 | Phase 2 | Phase 2 |
| Composer attach/send visible | Phase 3 | Phase 3 | Phase 3 | Phase 3 |
| Panel text legible without truncation | Phase 4 | Phase 4 | Phase 4 | Phase 4 |
| Focus trapped in dialogs | Phase 2 | Phase 2 | Phase 2 | Phase 2 |

Manual runbook: open chat → session drawer → new session sheet → model/thinking/settings/scoped/trust/login/logout/info/tree dialogs → More panels → Todo/Artifacts/Files/Router/Delegated work → MCP page + Add server → Plugins page. Verify each against the matrix and capture a proof frame.

## 7. Out of scope

- Native PWA installation, offline mode, push notifications or platform-specific mobile navigation bars.
- Full redesign of the desktop resizable panel layout beyond the short-landscape override.
- Changing session/agent behaviour; this is a client UX and static-routing plan only.
- Physical-device testing of iOS safe areas and Android keyboard behaviour — required before closing Phase 1 and Phase 2.

## 8. Source and evidence index

- `web/core/client/shell.tsx` — responsive panel state, header, dialog composition, plugin page routing.
- `web/core/client/base.css` — 7 media queries; dialog/sheet/coarse rules at `494`, `512`, `2561`, `2576`, `2628`, `2661`, `2669`.
- `web/core/client/plugin-system/plugins.css` — 10 media queries; drawer/menu/files/MCP/plugin-manager/router rules at `529`, `820`, `1167`, `1206`, `2148`, `2470`.
- `web/core/client/dialogs.tsx` — `DialogFrame` at `118-160`, ported dialogs through `1692`.
- `web/core/client/new-session-dialog.tsx`, `auth-gate.tsx`, `composer.tsx`, `transcript.tsx`, `sidebar.tsx`, `popups.tsx`.
- `web/plugins/files/*`, `web/plugins/artifacts/*`, `web/plugins/mcp-manager/McpManagerPage.tsx`, `web/plugins/plugin-manager/PluginManagerPage.tsx`, `web/plugins/router/*`.
- `web/core/server/client-static.ts:74-87` — extensionless SPA fallback; root cause of X1.
- Accepted review artifacts: `report-css-layout-audit-2`, `report-plugin-ui-audit-2` (and their remediation plans `plan-css-layout-audit`, `plan-plugin-ui-audit`).
