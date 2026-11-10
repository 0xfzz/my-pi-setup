# Pi workflow extensions

Extensions for [Pi](https://github.com/earendil-works/pi) (Node 22): a conditional todo
guardrail, workspace artifacts, durable delegated-work checkpoints, input modes
(Normal / Plan), a provider and account TUI, and a delegation surface for running
parallel child agents through handoffs, guardrails and accounted results.

Nothing here replaces Pi's system prompt, header, footer or global agent definitions.
Every extension is listed explicitly in `package.json`, so helpers and tests never load as
extensions.

## What this is

A set of Pi extensions that turn one Pi session into a small, supervised team. The
parent plans and verifies; child agents do bounded work in their own panes and hand
back a result the parent must check before it counts.

| Area | What you get |
| --- | --- |
| **Delegation** | `agent_spawn`, `agent_resume`, `agent_steer`, `agent_close`, `agent_accept_result` and friends: parallel child agents, each with a frozen handoff, a declared file lane, acceptance criteria, a question-and-escalation ladder, and a parent verdict before a slot is freed. |
| **Todo** | `todo_plan` / `todo_act` / `todo_next`: a dependency graph with leases and typed evidence, so "done" needs proof. |
| **Artifacts** | Plans, specs and scratchpads kept outside the chat turn, recalled on demand, referenced with `@artifact`. |
| **Modes** | Normal and Plan (read-only) input modes, enforced on tools rather than by prompt. |
| **Checkpoints and compaction** | Durable records of every child, milestone reports, and model-aware VCC auto-compaction. |
| **Providers and routing** | `/providers` editor, multi-account pools, `/router` virtual models with ordering, triggers and per-target failure cooldowns, and linked Google (Antigravity) accounts. |
| **Interface** | Right sidebar (`Alt+W` menu), shared popup frame, `ask_user` dialogs, Linux clipboard paste, cache stats. |
| **Dashboard** | A local, read-only browser view of the delegation graph and artifacts. |
| **Tools** | `web_read`, `google_search` and `generate_image` (vendored Antigravity), smart timeouts for `bash`. |

Every extension is listed in [Repository layout](#repository-layout) and in
`package.json` → `pi.extensions`. Start with [Delegation](docs/delegation.md).

## Requirements

| Needed | For | Notes |
| --- | --- | --- |
| **Node.js 22.6+** | Everything | Uses `--experimental-strip-types`; `engines` enforces it. |
| **[Pi](https://github.com/earendil-works/pi)** | Everything | Built and tested on 1.5.0. The manifest declares peer `@earendil-works/pi-coding-agent ~1.4.0`; install the Pi you actually run and tell `npm` to ignore the peer range if it complains. |
| **[Herdr](https://github.com/modem-dev/pi-herdr-subagents)** (terminal multiplexer) | Child agents | `agent_spawn` and friends start each child in a Herdr pane, so **run Pi inside Herdr**. Delegation needs it; I have not tested which other extensions still load without it. Developed on Herdr 0.9. |
| **npm** | The dashboard and development | Only `npm run build:dashboard` is needed to use the dashboard. |
| Rust + `wasm32-unknown-unknown` | Optional | Only to rebuild the sidebar animation (`npm run build:wasm`; the built `.wasm` is committed) or the no-write guard binary (`npm run build:nowrite`; the binary is not committed). |

## Setup

```sh
# 1. Get the code and keep it where it is: Pi loads it in place.
git clone <this repository> ~/projects/pi-workflow-extensions
cd ~/projects/pi-workflow-extensions
npm install --ignore-scripts --legacy-peer-deps

# 2. Build the dashboard bundle (it is generated, not committed).
npm run build:dashboard

# 3. Install the companion package this workflow depends on (see below).
pi install npm:pi-vcc

# 4. Install this package.
pi install ~/projects/pi-workflow-extensions

# 5. Start Pi inside Herdr, then restart or /reload.
```

Check it worked: `/subagents`, `/router`, `/provider` and `/artifacts` should open,
and the model can call `todo_plan` and `agent_spawn`.

To remove it: `pi remove ~/projects/pi-workflow-extensions`. To disable one extension
only, use `pi config` and untick it. Details in [install](docs/install.md).

## Companion packages

### Required

| Package | Why |
| --- | --- |
| `npm:pi-vcc` | The compaction and history engine. VCC auto-compaction, child "digest" briefs and `vcc_recall` all build on it, and `lib/vcc/` imports it directly. |

VCC auto-compaction is deployed as one file outside this package's manifest, on
purpose (two controllers would fight). Mirror it once, and again after changing
`lib/vcc/`:

```sh
node scripts/sync-vcc-auto-compact.mjs
```

It copies the entry point to `~/.pi/agent/extensions/auto-compact.ts`. See
[VCC compaction](docs/vcc.md).

### Recommended

These are not imported by this package, but it detects the tools or editor slots they
provide and is tuned around them.

| Package | What it adds | How this workflow uses it |
| --- | --- | --- |
| `npm:@ff-labs/pi-fff` | `ffgrep` / `fffind`, fast indexed search | Allow-listed for read-only children and Plan mode, and named in the prompt guidance. Without it children fall back to `grep` / `find`. |
| `npm:pi-paster` | Inline image paste (`[#image 1]`) | The editor wrapper and clipboard paste compose with the editor wrapper and clipboard paste instead of fighting for the single editor slot. |
| `npm:pi-mcp-adapter` | MCP servers as tools | Independent of this package; listed because it is part of the setup this was developed with. |
| `npm:betterwright` | A persistent browser tool | Independent of this package; useful for verifying web work a child reports. |
| `npm:pi-antigravity` or the vendored copy | Antigravity provider | This repo already vendors it (`vendor/antigravity/`). Do not install both. |

### Not needed

Nothing else is required. `pi-zentui` and similar UI packages are independent; this
workflow keeps its own sidebar, popups and prompt UI, so use one prompt/editor
replacement at a time.

## Configuration

Everything works with defaults. Files you may create:

| File | Purpose |
| --- | --- |
| `~/.pi/agent/account-router.json` (or `.pi/account-router.json` per project) | Pools and routes for `/router`. |
| `~/.pi/agent/models.json` | Providers and models written by `/providers`. |
| `~/.pi/agent/pi-vcc-config.json` | The `autoCompact` block that tunes compaction. |

Credentials live in Pi's own stores under `~/.pi/agent/`, never in this repository.

## Documentation

Each document is the detail for one part of the surface. `docs/patches/` is the applied
diff record, not documentation.

| Document | Answers |
| --- | --- |
| [Delegation](docs/delegation.md) | How delegated work runs: parent and child, the handoff, re-spawn on a missed handoff, the escalation ladder, and every guardrail. **Start here.** |
| [Auto title](docs/auto-title.md) | How an untitled session is named from its first exchange, what it refuses, and how to turn it off. |
| [Modes](docs/modes.md) | What Normal and Plan allow, how a switch is enforced, and why delegation is not a mode. |
| [Todo](docs/todo.md) | The intent graph: `todo_plan` / `todo_act` / `todo_next`, leases, derived state, typed evidence, and the v1 shim. |
| [Questions](docs/questions.md) | When the agent must ask, how a child routes a question to the parent, and why a cancelled dialog is never consent. |
| [Checkpoints](docs/checkpoints.md) | What the parent records about a child, milestone sidecars, recovery limits, and VCC history reduction. |
| [VCC compaction](docs/vcc.md) | The compaction policy, its calibration, telemetry and rollback. |
| [Token efficiency](docs/token-efficiency.md) | Prompt-cache stability, compact schemas and per-model prompt profiles. |
| [Artifacts](docs/artifacts.md) | Storing, recalling and editing plans, specs and scratchpads outside the chat turn, plus `@artifact` mentions. |
| [Dashboard](docs/dashboard.md) | The local read-only graph, artifact views, and the server's bounds and trust model. |
| [Pi Web](docs/pi-web.md) | Operator guide for the first-party web client: setup, build/dev server, shadcn/Tailwind/Phosphor design system, plugin views, trust bounds, and resyncing. |
| [Smart timeout](docs/smart-timeout.md) | Wall-clock and idle limits for `bash`, explicit budgets, and timeout diagnostics. |
| [Stream recovery](docs/stream-recovery.md) | Save interrupted write/command prefixes and continue with only the missing suffix, without replaying executed tools. |
| [Sidebar](docs/sidebar.md) | The right rail, the `Alt+W` prefix menu, and the detail popups. |
| [Image thumbnails](docs/image-thumbnails.md) | Why inline images lag and how every displayed image becomes a thumbnail while the original is never touched. |
| [Clipboard](docs/clipboard.md) | Pasting in every Linux terminal: Wayland, X11, tmux and Termux backends, and why plain `Ctrl+V` used to do nothing. |
| [UI](docs/ui.md) | The shared popup frame, list, markdown viewer, ask popup, keys and responsive rules. |
| [Web plugin catalog](docs/web-plugin-catalog.md) | Every extension point a web plugin can use, with stability, version, and protection. Generated. |
| [Web plugin architecture](docs/web-plugin-architecture.md) | The boundary rule — web = interface, pi extension = behavior — the contracts, the lifecycle, and the enforced import graph. |
| [Providers](docs/providers.md) | A walkable editor for providers and their models in the TUI, plus dialog commands, including compatibility flags. |
| [Accounts](docs/accounts.md) | Pooling several accounts per provider and routing each request, with `/router` as an editor for the routes, their routing method and when they re-decide. |
| [Antigravity](docs/antigravity.md) | Linking Google accounts as `antigravity-1…n` providers. |
| [Verification](docs/verification.md) | What the suites cover, what they mock, and how to run them. |
| [References](docs/references.md) | Upstream projects and prior art, and what this package adds on top. |

## Repository layout

Every top-level directory holds a class of thing, not a single file (`vcc/`, which held
one, is gone — its entry point lives in `lib/vcc/` with the policy it wires up). Every
directory below answers "what lives here?" without needing an explanation.

| Path | What lives there |
| --- | --- |
| `extensions/` | The installable extensions listed in `package.json` → `pi.extensions`. Nothing else: helpers belong in `lib/`. |
| `lib/` | Shared implementation, not loaded as extensions. Subdivided by concept — see below. |
| `tests/` | `node:test` suites, mirroring the source tree: `tests/*.test.ts`, `tests/provider/`, `tests/sidebar/`, `tests/delegation/`. Add a group to `package.json` → `test` when you add a directory. |
| `scripts/` | Repo tooling: the dashboard build, the WASM build, the VCC mirror, and the dashboard dev preview server. |
| `web/` | The browser dashboard's static sources and build output (see its `README.md`). |
| `vendor/` | Third-party code kept in-tree: `pi-herdr-subagents` (see its `VENDORED.md`) and `antigravity`. A source snapshot — read `VENDORED.md` before touching it. |
| `docs/` | One document per part of the surface, indexed above, each following [`docs/TEMPLATE.md`](docs/TEMPLATE.md); `docs/patches/` holds the diffs applied to installed packages. |
| `crates/` | Optional Rust/WASM helpers (`npm run build:wasm`, `npm run build:nowrite`). |

Inside `lib/`, each directory is one concept; loose files at the root are the ones that
truly cut across all of them (tool policy, naming, clipboard, the intent graph):

| `lib/` subdirectory | Holds |
| --- | --- |
| `provider/` | Providers, their models, accounts, and the router that chooses between them. |
| `sidebar/` | The right rail: layout, resize, channel, selection, animation, on-demand rendering. |
| `plan/` | Plan mode's branch-local policy and the closed shell grammar it enforces. |
| `popup/` | The shared popup frame and the editor composition layer that drives it. |
| `ui/` | The specific dialogs built on that frame (ask, provider settings, router settings). |
| `delegation/` | Delegated-work machinery: admission, handoff, review policy, escalation, the registry. |
| `vcc/` | Compaction policy, budget, telemetry, and the deployed entry point. |
| `dashboard/` | Dashboard protocol, projection, server and lifecycle. |
| `selection/` | Terminal text selection and OSC 8 hyperlink handling. |

## Verification

```sh
npm run typecheck
npm test
```

The only accepted failures are the two documented `native … inline custom UI reproduces
clipping…` tests. Details in [verification](docs/verification.md).

## Credits

This package bundles and builds on other people's work. Full upstream details and
the local changes are in each `VENDORED.md`; licences are kept next to the code.

| Project | Author | Licence | Where it lives here |
| --- | --- | --- | --- |
| [pi-herdr-subagents](https://github.com/modem-dev/pi-herdr-subagents) | Justin (modem-dev) | MIT | Vendored in [`vendor/pi-herdr-subagents/`](vendor/pi-herdr-subagents/VENDORED.md): the Herdr launch planner, socket client, watcher and the `agent_done` / `agent_ping` handshake that delegation runs on. Locally patched. |
| [pi-antigravity](https://github.com/Rahularya01/pi-antigravity) | Rahul Arya | MIT | Vendored in [`vendor/antigravity/`](vendor/antigravity/VENDORED.md) ([licence](vendor/antigravity/LICENSE)): the Antigravity / Cloud Code Assist provider. The multi-account layer on top is this package's own. |
| [Phosphor Icons](https://github.com/phosphor-icons/core) | Phosphor Icons | MIT | Dashboard icon sprite, unmodified ([provenance](web/dashboard/ICONS.md), [licence](web/dashboard/licenses/phosphor-icons-MIT.txt)). |
| [ascii.rest/aquarium](https://ascii.rest/aquarium/) | @bas3line | MIT | Aquarium art and swimming equations, adapted for the sidebar animation. |
| [pi-vcc](https://www.npmjs.com/package/pi-vcc) | its authors | see package | Not bundled; the compaction engine this package's VCC controller wraps. |
| [pi-model-router](https://github.com/yeliu84/pi-model-router/) | yeliu84 | see repo | Prior art for virtual-model routing; no code copied. |

Runtime libraries: [`@viz-js/viz`](https://github.com/mdaines/viz-js) (graph layout),
[`marked`](https://github.com/markedjs/marked), [`DOMPurify`](https://github.com/cure53/DOMPurify)
and [`highlight.js`](https://highlightjs.org/) for the dashboard. See
[References](docs/references.md) for the design material behind the rest.

Pi itself is by [earendil-works](https://github.com/earendil-works/pi).

## License

MIT — see [LICENSE](LICENSE).
