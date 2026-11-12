# PRD: File manager / file viewer + pinnable sidebar launcher

> Reuse the existing right sidebar to browse project files and preview their contents without leaving the conversation. Compose proven libraries; do not build a tree engine, virtualizer, editor, document renderer, or menu interaction engine from scratch.

| Field | Value |
| --- | --- |
| **Status** | Draft — PRD only; no implementation or dependency installation |
| **Owner** | Faiz |
| **Branch** | `feat/file-manager-file-viewer-plugin` |
| **Parent** | [Plugin platform](pi-web-plugin-platform.md), [Pluggable UI](pi-web-pluggable-ui.md), [Plugin actions](plugin-actions.md) |
| **Deliverables** | A Files plugin in the existing right sidebar; a shared launcher with at most three pinned panel icons and a separate three-dot menu |

## 1. Problem and goals

Users need to inspect files produced or modified during a session without opening a separate file manager. Large repositories must not freeze the chat. Meanwhile, the current launcher renders one icon for every available panel, so installing plugins makes the toolbar crowded.

Goals:

- **G1 — Contextual browsing:** browse the selected session's project directory, navigate folders, find a file, and preview it in the existing right sidebar.
- **G2 — Library-first performance:** use maintained libraries for established functionality, lazy loading for expensive viewers, and bounded data/DOM work.
- **G3 — Compact navigation:** display **zero to three pinned feature/plugin icons, plus one ⋯ button**. The ⋯ button does not count toward the three-feature cap.
- **G4 — User ownership:** pin/unpin panels; persist the choice; never silently evict a pin or automatically pin a newly installed plugin.
- **G5 — Safe inspection:** never execute previewed project content, leak files outside the authorized root, or interfere with a running conversation.

### Scope assumptions

“File manager” means **browse, search, inspect, copy relative path, and explicitly download** in v1. File writes are deliberately deferred: create, edit/save, upload, rename, move, delete, clipboard file operations, drag-and-drop mutations, and archive extraction require a separate mutation specification. This is a proposed scope boundary, not a claim that those capabilities were requested to be excluded.

The reference image is design inspiration, not a requirement to reproduce another application's entire layout. Chat remains the primary workspace; both browsing and viewing stay inside the existing right sidebar. No second sidebar, standalone file-manager page, or full IDE in v1.

## 2. Existing integration points and constraints

| Existing code | Observed behavior / implication |
| --- | --- |
| `web/client/plugins/PluginPanelNav.tsx` | Maps every panel descriptor to an icon button; no pin policy or overflow menu. Extend this shared launcher, not Files alone. |
| `web/client/plugins/PluginSidePanel.tsx` | Owns the existing right-hand panel, header, close button, optional page link, view renderer, and action buttons. Reuse its shell. |
| `web/client/plugins/panel-policy.ts`, `web/client/shell.tsx` | Select eligible panels and control the active panel. Keep one active panel and the existing registration/enablement flow. |
| `lib/web-plugins/descriptor.ts` | Descriptors already have stable IDs, titles, host-owned icons (including `files`), and sidebar surfaces. Use these instead of another plugin catalog. |
| `lib/web-plugins/view.ts` | Current views are `kv`, `list`, `status`, `graph`, and `dialog`; generic rows are bounded at 200. A filesystem is not a giant generic list view. |
| `lib/web-plugins/actions.ts` | Actions carry request/plugin/action/session IDs, not arbitrary file-path payloads. Do not smuggle paths through action IDs. |
| `web/client/plugins/markdown.tsx` | Existing `react-markdown` + `remark-gfm` renderer; raw HTML is not enabled. Reuse its safe rendering policy. |
| `web/package.json`, `web/build.mjs` | React 19, esbuild, Phosphor icons, several Radix primitives, and Markdown dependencies already exist. Verify worker/chunk output against this build pipeline. |

**Required platform seam:** introduce a small, validated Files view/capability and a host-owned, lazy-loaded renderer dispatched through the existing panel. The extension provides availability/root context; the host provides typed, session-authorized file reads. Third-party descriptors must not gain arbitrary browser code or filesystem access by declaring this view. Keep existing view limits and legacy panels unchanged.

The Files panel must be available when its plugin is enabled and a session has an authorized root, even before any tool has emitted an artifact. Missing/unavailable roots produce a clear state, not a hidden feature.

## 3. Library research and selection

### 3.1 Recommended stack

Recommendations below are based on documented capabilities and architectural fit, **not comparative benchmarks run in this repository**. No library is declared objectively “fastest.” Exact versions, licenses, React compatibility, maintenance/security status, and measured chunk costs must be checked and recorded during the implementation spike.

| Concern | Recommendation | Why / constraints |
| --- | --- | --- |
| Accessible, lazy filesystem tree | `@headless-tree/core` + `@headless-tree/react` | Headless Tree supports asynchronous data loading, tree interaction/accessibility, and virtualization integration. Fits on-demand directory reads and existing styles. Delegate keyboard navigation, focus, expansion, and selection to it. |
| Tree/search row virtualization | `@tanstack/react-virtual` | Headless windowing renders visible rows plus overscan instead of every file. Integrate with the tree's flattened visible items; do not write a second tree-flattening or scroll-window engine. |
| Read-only code/text | CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, selected language/search extensions) | Modular editor architecture with viewport-oriented rendering. Use read-only configuration, line numbers, selection/copy, and library search. Load languages only when needed; no Monaco-sized IDE requirement. |
| Markdown | Existing `react-markdown` + `remark-gfm` | Already integrated. Preserve raw-HTML and URL restrictions; use a size limit because Markdown rendering is not automatically virtualized. Source mode uses CodeMirror. |
| PDF | `pdfjs-dist` with its maintained viewer components | Worker-based parsing; reuse navigation, rendering queue, text layer, and zoom components rather than hand-building a PDF viewer. Render only visible pages; use authenticated HTTP Range support. |
| Raster images and supported audio/video | Native browser elements | `<img>`, `<audio controls>`, and `<video controls>` already supply optimized decoding/playback. No codec/parser package or custom media player. No autoplay. |
| Overflow/pin menus | `@radix-ui/react-dropdown-menu` | Consistent with existing Radix usage; provides keyboard navigation, focus, dismissal, positioning, and submenu behavior. No homemade popup/focus-trap engine. |
| Icons/tooltips | Existing Phosphor icons and Radix tooltip | Reuse host-owned symbols and existing visual conventions. |
| Resizing, if added | `react-resizable-panels` | Use its keyboard-accessible separators and size constraints, not bespoke pointer tracking. Do not replace unrelated shell layout solely to add resizing. |
| Filename fuzzy ranking, if needed after baseline | `fzf` (FZF for JavaScript) | Existing matching algorithm for path candidates; use a worker for large candidate sets. v1 may ship explicit substring matching without fuzzy ranking. Do not invent a fuzzy scoring algorithm. |

Custom work is limited to product policy, secure session/root authorization, typed adapters, rendering composition/styles, and tests. Standard filesystem and browser APIs are reuse, not a reason to add a package for trivial glue. Before any substantial custom subsystem, record the existing utility/library considered and why it cannot meet the requirement.

### 3.2 Alternatives and decisions

| Candidate | Decision |
| --- | --- |
| React Arborist | Strong alternative: integrated virtualization, selection, keyboard navigation, and file-tree interactions. Compare against Headless Tree in the spike; choose it if async directory loading can be adapted with less code and the same bounds. Do not install both in production. |
| React Complex Tree | Considered, but evaluate its successor Headless Tree first for a new implementation. |
| SVAR React File Manager | Evaluate as a ready-made alternative before writing significant UI glue. Accept only if its directory-loading, preview customization, accessibility, license, and compact-sidebar behavior satisfy this PRD. A complete file manager is not automatically the best fit for a narrow read-only plugin. |
| Monaco Editor | Defer: an IDE/editor surface exceeds the read-only viewer requirement. Reconsider only if measurements or future editing needs justify it. |
| Generic all-format document-viewer wrapper | Not the default: underlying renderers, external services, bundle weight, and security behavior still require evaluation. No uploads to a third-party document service. |
| Mammoth / `docx-preview` | Defer DOCX to v2. Mammoth targets semantic HTML, not exact Word layout, and explicitly does not sanitize output. Any future integration needs sanitization, external-resource blocking, and archive/decompression limits. |

**Spike exit gate:** compare Headless Tree + TanStack Virtual with React Arborist and inspect the ready-made SVAR option using the same large-directory fixtures. Record async-loading behavior, rendered rows, timings, transferred JS, integration code, accessibility, and license. Keep the simplest maintained candidate that passes §8. A failed benchmark must change the decision or requirement explicitly, not be hidden behind “blazingly fast” marketing.

### 3.3 Primary sources

- [Headless Tree — getting started](https://headless-tree.lukasbach.com/getstarted/) and [repository](https://github.com/lukasbach/headless-tree): tree features and integration.
- [React Arborist](https://github.com/jameskerr/react-arborist): integrated virtualized tree alternative.
- [TanStack Virtual introduction](https://tanstack.com/virtual/latest/docs/introduction): headless windowing and visible-row rendering.
- [CodeMirror](https://codemirror.net/): modular editor and large-document approach.
- [PDF.js FAQ](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions): visible-page rendering, canvas-memory cost, matching worker versions, and range loading.
- [Radix Dropdown Menu](https://www.radix-ui.com/primitives/docs/components/dropdown-menu): accessibility, focus, keyboard navigation, and submenus.
- [React Resizable Panels](https://github.com/bvaughn/react-resizable-panels): layout and accessible separators.
- [FZF for JavaScript](https://github.com/ajitid/fzf-for-js): existing fuzzy-matching implementation.
- [Mammoth](https://github.com/mwilliamson/mammoth.js): semantic conversion and security limitations.
- [SVAR React File Manager](https://github.com/svar-widgets/react-filemanager): ready-made candidate; verify current distribution/license during the spike.

## 4. Primary experience: Files in the right sidebar

### 4.1 Layout and behavior

- Register one **Files** panel with a stable plugin ID and the existing `files` icon.
- Opening it uses `PluginSidePanel`, retains chat/composer state, and never starts or interrupts a model turn.
- Header: Files title, project/root label, refresh, and existing close control. Show the full root/path accessibly without forcing horizontal page scrolling.
- Browser mode: path breadcrumb, filename search, hidden-file toggle, and virtualized tree. Folders sort before files, then natural name order using standard collation.
- Expand a folder on demand. Single-select a file and open its preview; Enter performs the same action. Preserve expansion and scroll when returning to the browser.
- Narrow sidebar: browser and preview are two views in the **same** panel, with a visible “Back to files” control. Wider layouts may use a vertical browser/preview split through the resizing library, but not two cramped side-by-side columns.
- Preview header: filename, root-relative path, type, size, modified time, Copy path, and explicit Download. Copy path copies the relative path, not the file contents.
- One preview at a time in v1. Selecting another file cancels superseded work and releases the previous viewer's resources.
- Restore expansion/selection/scroll in memory per session + root. Do not persist file contents or document blobs in local storage. Browser reload may reset browsing state; pin preferences must survive.
- On session/root change, clear the visible old preview immediately; cancel old requests. Late responses cannot populate the new session's panel.

### 4.2 File discovery

- Root comes from the authorized selected session's working directory, never a client-supplied absolute root.
- Initial load lists only the root directory; no recursive repository crawl on panel open.
- Directory responses are bounded/paged, initially at most 500 entries per response. Clearly expose “Load more” or library-supported incremental loading; no silent omissions.
- Hidden entries are off by default. Heavy directories such as `.git`, `node_modules`, build output, and vendor directories are excluded from recursive search by default, but can be explicitly navigated where authorized. Show search exclusions to the user.
- Search means **filename/path search**, not file-content search. State whether results cover loaded entries or the whole project. The release target is project search with cancellable, bounded traversal/indexing using a maintained discovery utility or existing host search service; never block the Node event loop on a synchronous recursive scan.
- Return at most 200 search matches per response with an explicit truncation/continuation indicator. Search order must be specified (natural path order for substring mode; library rank for fuzzy mode).
- Refresh invalidates the current directory and preview metadata. v1 does not require watching every project file; external changes are detected on refresh/reopen and displayed without pretending stale content is current.

### 4.3 Preview matrix

| File class | v1 behavior |
| --- | --- |
| UTF-8 source, JSON, YAML, config, logs, plain text | Read-only CodeMirror; line numbers, horizontal scroll/wrap option, text selection/copy, find. Never execute scripts. |
| Markdown | Safe rendered/source toggle, reusing existing Markdown policy. Remote images/resources disabled by default; sanitize links consistently. |
| PNG, JPEG, WebP, GIF and browser-supported raster formats | Native image rendering, fit-to-panel, dimensions. Preserve animation behavior where supported; no thumbnail storm during listing. |
| PDF | Lazy PDF.js viewer/worker with page navigation, zoom, selectable text, bounded visible-page rendering, and download. Encrypted/malformed files receive actionable errors. |
| Browser-supported audio/video | Native controls, metadata-only preload, no autoplay, streaming/range response. Unsupported codecs show fallback. |
| HTML, SVG, notebooks | Source only in v1; never inject active HTML/SVG or execute notebook cells. |
| DOCX, XLSX, PPTX, archives, executables, unknown/binary formats | Metadata + “Preview unavailable” + explicit download. No false promise of universal preview. |

Initial protective limits, configurable only through trusted host settings: text/source preview 2 MiB; rendered Markdown 512 KiB; PDF 50 MiB; raster image 20 MiB with a decoded-pixel guard where dimensions can be safely inspected before display. Over-limit content gets metadata and download rather than an unbounded read. A bounded text prefix may be offered only with a prominent truncation notice and correct UTF-8 boundary handling. Media streams rather than buffering the entire file. Viewer failures must not crash the shell.

## 5. Side quest: shared three-icon launcher and pin/unpin

### 5.1 Launcher rules

1. At most **three feature icons** are visible, in saved pin order, followed by a separate **⋯ More panels** button. Four total controls is the maximum.
2. The ⋯ menu lists **all installed, enabled, sidebar-eligible features/plugins**, including already pinned ones—not only overflow. Every entry has its icon, full title, active indicator, and pin state.
3. Panels temporarily unavailable in the current session remain discoverable in the menu with an unavailable reason; they cannot be opened. Page-only plugins and non-panel commands do not appear here.
4. Clicking a pinned icon toggles its panel. Choosing a panel from the menu opens/focuses it and closes the menu; choosing the already active panel leaves it open. Neither operation changes pins.
5. Opening an unpinned panel never adds a fourth icon or evicts a pinned one. The ⋯ trigger indicates that an overflow panel is active; the panel header always identifies it.
6. If all panels are unpinned, only ⋯ remains. If no eligible panels exist at all, hide the launcher.

### 5.2 Pin behavior and persistence

- Provide an explicit **Pin / Unpin** action for each entry. Use accessible library-owned submenus or separate menu actions; do not nest an interactive button inside another menu item/button.
- Pinning with fewer than three pins appends the ID. Unpinning removes that ID and leaves other pins in order; it does not close an active panel or auto-fill the empty slot.
- When three are pinned, reject a fourth pin with “You can pin up to 3 panels. Unpin one first.” Opening that feature remains possible. No automatic replacement.
- Fresh preferences: seed up to the first three eligible panels in existing stable registration order **once**. Do not reshuffle or re-seed on session changes or after an explicit empty pin list.
- Persist a versioned ordered ID list in browser-local preferences scoped to the host/user context supported by the application. Store no titles, icons, paths, or contents. If user identity exists, namespace by it; otherwise preferences are browser-profile/origin local, not cross-device.
- Validate reads: deduplicate IDs, enforce max three, tolerate invalid JSON/schema versions/storage denial. Missing or temporarily disabled plugin IDs retain their saved position, are hidden from the visible rail, and return when available. They still occupy a saved pin slot; expose an “Unavailable pins” management section to remove them.
- Newly installed plugins appear in ⋯ unpinned after preferences exist. Titles/icons resolve from current descriptors, so renaming a title does not lose the pin.
- No drag-to-reorder or cross-device sync in v1; unpin/re-pin moves an entry to the end.

### 5.3 Keyboard and responsive behavior

- Icons have accessible names/tooltips; ⋯ has `aria-expanded` and a descriptive name. Active state must not rely on color alone.
- Radix manages menu focus, arrows, Enter/Space, typeahead, Escape, outside-click dismissal, and focus return. Pin actions cannot accidentally open/close the sidebar.
- Escape closes the innermost menu/search/viewer overlay first. The existing global panel Escape handler must respect handled events, so closing ⋯ does not also close Files.
- Tree keyboard behavior comes from the tree library. Restore focus to the relevant launcher after closing the panel and to the selected file after returning from preview.
- Keep the existing responsive right-panel behavior, with an accessible drawer/dialog at narrow widths. Preserve the three-pin cap at every breakpoint; reduce visible shortcuts only if necessary for fit, with all entries still available in ⋯ and saved pins unchanged.

## 6. Data and security requirements

The web server can access local files; that is a privileged boundary, not a generic static-file endpoint.

- Typed operations: list directory, search paths, stat metadata, bounded preview read, and explicit streamed download. Requests contain session ID and root-relative path/opaque entry ID; root identity and authorization are resolved server-side for **every** request, including Range/download.
- Reuse existing host authentication, session authorization, routing, error handling, and request validation. If current deployment has no suitable authorization boundary, keep the feature unavailable to remote clients until one exists; do not expose a new unauthenticated file server.
- Prefer disallowing symlink traversal in v1. Display symlinks as such with an unsupported reason. Reject absolute paths, traversal, NULs, encoded traversal, and path-component escapes; use platform path semantics and canonical root containment, not string-prefix checks. Validate the opened object is a permitted regular file/directory; refuse devices, sockets, and pipes.
- Resolve and open defensively against symlink replacement/TOCTOU. The implementation spike must establish a platform-supported safe-open strategy or explicitly reject unsupported configurations; a one-time `realpath` check alone is insufficient.
- Do not execute shell commands interpolated with paths. Search/discovery utilities must receive structured arguments and cancellation/resource bounds.
- Respect file permissions. Return sanitized errors for missing, changed, denied, offline, too-large, unsupported, or stale requests without exposing arbitrary host paths or stack traces.
- Use accurate allowlisted content types, `X-Content-Type-Options: nosniff`, safe attachment filenames, and no executable same-origin HTML/SVG preview endpoints. Unknown files download as attachments. Content remains data, never plugin instructions or model context automatically.
- No external viewer services, CDN runtime dependencies, automatic uploads, or remote resource fetches from document content. Bundle the PDF worker at exactly the renderer's version. Review PDF scripting/external-link options and disable active content.
- Use private/no-store caching for file bytes; bounded in-memory metadata/content caches keyed by session + root + path + revision. Invalidate on session/root switch and metadata change. Log timings and error categories, not file contents or secrets.
- Downloads happen only on explicit user action; stream with backpressure and validated Range support. Never automatically download a file because preview failed.

## 7. Loading and failure states

Required visible states: no selected session, unavailable root, disconnected host, loading directory, empty directory, directory permission denied, loading search, no matches, partial/truncated results, loading preview, file removed/changed, unsupported format, over-limit file, decoding/render failure, and download failure.

Each error is local to its directory/viewer with a relevant retry/back/download action. Cancelled or superseded requests are not displayed as errors. Show progress without blocking composer input; do not announce every tree row or streaming chunk to screen readers.

## 8. Performance contract and measurement

These are **proposed release targets**, not measured results. Use production builds on one recorded reference machine/browser (hardware, OS, browser version, viewport, cold/warm cache, and network latency documented). Run at least 30 samples per timing and report p50/p95. Measure while the chat is streaming as well as idle.

Fixtures: 100,000 files across nested directories, one directory with 10,000 direct entries, a 1 MiB/50,000-line source file plus a long-line case, 512 KiB Markdown, a representative 100-page PDF under 20 MiB, a large raster image, and unsupported/malformed samples. Excluded folders and symlinks are included in correctness fixtures.

| Metric | Proposed gate |
| --- | --- |
| Cached launcher/menu/panel response | p95 ≤100 ms from input to visible response |
| Cold directory first page, local SSD/localhost | p95 ≤300 ms server response; ≤500 ms to visible rows, excluding first download of the feature chunk |
| Cached folder expansion / selection | p95 ≤100 ms |
| Directory/search DOM | Visible rows plus overscan; ≤150 mounted rows in the reference 900px-tall viewport, independent of total fixture size |
| Scrolling | p95 frame time ≤20 ms over a recorded 10-second scroll; no file-feature main-thread task >100 ms |
| 1 MiB text first usable viewport, warm viewer | p95 ≤300 ms after bytes arrive |
| Warm indexed filename search | p95 ≤150 ms after query dispatch; show partial/indexing state during cold discovery |
| PDF first page | p95 ≤1 s after required bytes arrive for the reference PDF; only visible/near-visible pages retain canvases |
| Idle cost | No directory enumeration, search, file reads, PDF worker, or file-viewer downloads before Files is opened |
| Shell bundle growth | ≤15 KiB gzip initial JS increase for launcher/registration; tree/editor/PDF code and language packs are separate lazy chunks |
| Resource cleanup | After 20 file switches and panel closes, no accumulating workers, object URLs, canvases, subscriptions, or in-flight requests |

A small file size does not guarantee a cheap PDF/image decode. Resource limits and cancellation remain required even when benchmarks pass. Record per-viewer transferred JS and retained memory; don't invent unmeasured package-size numbers.

## 9. Acceptance criteria

- **AC1 — Sidebar reuse:** Files opens inside the existing panel; other panels, chat streaming, session switching, and composer behavior remain intact.
- **AC2 — Library-first:** tree interaction, row virtualization, code viewing, PDF rendering, and menu behavior come from the selected libraries; selection evidence and license checks are recorded.
- **AC3 — Discovery:** root/folder navigation, pagination, hidden entries, filename search, copy path, refresh, and explicit download work with truthful partial/error states.
- **AC4 — Preview:** every row of §4.3 has a tested renderer or explicit fallback. Read-only really means no save/write endpoint or accidental execution.
- **AC5 — Large data:** §8 targets are measured on named fixtures, including streaming chat; no full-tree render or eager file-content crawl.
- **AC6 — Three-pin cap:** with at least eight eligible plugins, exactly zero to three pinned icons plus ⋯ appear; ⋯ lists every eligible panel with icon and full title, including pinned entries.
- **AC7 — Preference semantics:** pin/unpin, fourth-pin refusal, empty pins, reload persistence, malformed/denied storage, new plugins, unavailable pins, and renamed titles follow §5.
- **AC8 — Active overflow:** an unpinned feature opens without changing pins; unpinning the active feature keeps it open; menu and icon activation follow their defined semantics.
- **AC9 — Isolation:** traversal/encoding, symlink escape and replacement, unauthorized session/download/range, stale responses, non-regular files, permission failures, and malformed documents are tested and fail safely.
- **AC10 — Accessibility:** keyboard-only open/browse/preview/back/pin/unpin/close works; focus and Escape layering are correct; automated checks plus manual screen-reader checks cover the virtualized tree and menu.
- **AC11 — Verification:** relevant unit/integration/browser tests, production build/worker loading, and repository `npm run tidy` pass. Only the repository's two documented TUI clipping baseline failures may be accepted; report them explicitly.

Browser evidence for implementation must show: Files browsing and preview inside the right sidebar, the three-icon cap with eight plugins, ⋯ listing icons/titles including pinned entries, pin/unpin plus reload persistence, an active unpinned panel, and narrow-width behavior. This PRD does not claim those behaviors already exist.

## 10. Delivery sequence (future implementation)

1. **Library/security spike:** compare candidates, validate async paging and accessible virtualization, benchmark representative fixtures, establish filesystem authorization/safe-open strategy, and confirm worker/chunk support. No broad framework rewrite.
2. **Shared launcher:** pure pin policy + validated persistence + Radix overflow UI; tests for all preference/active states. Ship independently of Files.
3. **Files foundation:** registration/capability, session-scoped read service, lazy tree, search, refresh, state isolation, and metadata/fallback preview.
4. **Viewers:** CodeMirror, existing safe Markdown, native raster/media, then PDF.js. Integrate each behind its lazy boundary with limits and failure tests.
5. **Hardening/release:** security adversarial fixtures, accessibility review, benchmark report, responsive browser evidence, full verification gate.

Keep refactors separate from behavior changes and commit each verified coherent work unit. This PRD change installs no packages and implements none of these steps.

## 11. Decisions to revisit, not blockers to writing the PRD

- Confirm whether v1 should include filesystem mutations; this draft deliberately starts read-only.
- Confirm whether DOCX/spreadsheet/presentation rendering is needed; v1 offers download fallback.
- Choose the final tree package after the bounded comparison; Headless Tree + TanStack Virtual is the proposed default, not an irreversible commitment.
- Tune preview limits and timing budgets using recorded hardware/results without silently dropping safety requirements.
- Cross-device pin sync, drag reordering, recursive live watching, multi-root browsing, multi-tab previews, git status/diffs, and editing remain future work.
