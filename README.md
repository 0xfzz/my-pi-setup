# Pi workflow extensions

Extensions for [Pi](https://github.com/earendil-works/pi) (Node 22): a conditional todo
guardrail, workspace artifacts, durable delegated-work checkpoints, input modes
(Normal / Plan), a provider and account TUI, and a delegation surface for running
parallel child agents through handoffs, guardrails and accounted results.

Nothing here replaces Pi's system prompt, header, footer or global agent definitions.
Every extension is listed explicitly in `package.json`, so helpers and tests never load as
extensions.

## Install

```sh
pi install /absolute/path/to/pi-workflow-extensions
# restart Pi, or /reload in a session with no running children
pi remove /absolute/path/to/pi-workflow-extensions
```

The local package must stay where it is while installed. For install details, development
commands and the removal checklist, see [install](docs/install.md).

## Documentation

Each document is the detail for one part of the surface. `docs/patches/` is the applied
diff record, not documentation.

| Document | Answers |
| --- | --- |
| [Delegation](docs/delegation.md) | How delegated work runs: parent and child, the handoff, re-spawn on a missed handoff, the escalation ladder, and every guardrail. **Start here.** |
| [Modes](docs/modes.md) | What Normal and Plan allow, how a switch is enforced, and why delegation is not a mode. |
| [Todo](docs/todo.md) | The intent graph: `todo_plan` / `todo_act` / `todo_next`, leases, derived state, typed evidence, and the v1 shim. |
| [Questions](docs/questions.md) | When the agent must ask, how a child routes a question to the parent, and why a cancelled dialog is never consent. |
| [Checkpoints](docs/checkpoints.md) | What the parent records about a child, milestone sidecars, recovery limits, and VCC history reduction. |
| [VCC compaction](docs/vcc.md) | The compaction policy, its calibration, telemetry and rollback. |
| [Artifacts](docs/artifacts.md) | Storing, recalling and editing plans, specs and scratchpads outside the chat turn, plus `@artifact` mentions. |
| [Dashboard](docs/dashboard.md) | The local read-only graph, artifact views, and the server's bounds and trust model. |
| [Smart timeout](docs/smart-timeout.md) | Wall-clock and idle limits for `bash`, explicit budgets, and timeout diagnostics. |
| [Sidebar](docs/sidebar.md) | The right rail, the `Alt+W` prefix menu, and the detail popups. |
| [Clipboard](docs/clipboard.md) | Pasting in every Linux terminal: Wayland, X11, tmux and Termux backends, and why plain `Ctrl+V` used to do nothing. |
| [UI](docs/ui.md) | The shared popup frame, list, markdown viewer, ask popup, keys and responsive rules. |
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

## License

MIT — see [LICENSE](LICENSE).
