# Pi workflow extensions

Extensions for [Pi](https://github.com/earendil-works/pi) (Node 22): a conditional todo
guardrail, workspace artifacts, durable delegated-work checkpoints, input modes
(Normal / Plan / Orchestrator), a provider and account TUI, and the orchestrator that runs
parallel delegated work through handoffs, gates and receipts.

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
| [Orchestrator](docs/orchestrator.md) | How delegated work runs: handoff → spawn → check → review, the gates, the escalation ladder, and the role contract. **Start here.** |
| [Modes](docs/modes.md) | What Normal, Plan and Orchestrator allow, how a switch is enforced, and what a refused switch means. |
| [Todo](docs/todo.md) | The `workflow_todo` guardrail: assessment, atomic sync, evidence, blocked states, loop correction, and its limits. |
| [Questions](docs/questions.md) | When the agent must ask, how a child routes a question to the parent, and why a cancelled dialog is never consent. |
| [Checkpoints](docs/checkpoints.md) | What the parent records about a child, milestone sidecars, recovery limits, and VCC history reduction. |
| [VCC compaction](docs/vcc.md) | The compaction policy, its calibration, telemetry and rollback. |
| [Artifacts](docs/artifacts.md) | Storing, recalling and editing plans, specs and scratchpads outside the chat turn, plus `@artifact` mentions. |
| [Dashboard](docs/dashboard.md) | The local read-only graph, artifact views, and the server's bounds and trust model. |
| [Smart timeout](docs/smart-timeout.md) | Wall-clock and idle limits for `bash`, explicit budgets, and timeout diagnostics. |
| [Sidebar](docs/sidebar.md) | The right rail, the `Alt+W` prefix menu, and the detail popups. |
| [UI](docs/ui.md) | The shared popup frame, list, markdown viewer, ask popup, keys and responsive rules. |
| [Providers](docs/providers.md) | Adding and editing providers and models in the TUI, including compatibility flags. |
| [Accounts](docs/accounts.md) | Pooling several accounts per provider and routing each request. |
| [Antigravity](docs/antigravity.md) | Linking Google accounts as `antigravity-1…n` providers. |
| [Verification](docs/verification.md) | What the suites cover, what they mock, and how to run them. |
| [References](docs/references.md) | Upstream projects and prior art, and what this package adds on top. |

## Repository layout

| Path | What lives there |
| --- | --- |
| `extensions/` | The installable extensions listed in `package.json` → `pi.extensions`. |
| `lib/` | Shared implementation (todo state machine, artifacts, orchestrator registry, VCC adapter). Not loaded as extensions. |
| `tests/` | `node:test` suites: `tests/*.test.ts` plus the orchestrator suite in `tests/orchestrator/`. |
| `vendor/` | Third-party code kept in-tree: `pi-herdr-subagents` (see its `VENDORED.md`) and `antigravity`. |
| `docs/` | One document per part of the surface, indexed above; `docs/patches/` holds the diffs applied to installed packages. |
| `crates/` | Optional Rust/WASM ascii animation engine (`npm run build:wasm`). |

## Verification

```sh
npm run typecheck
npm test
```

The only accepted failures are the two documented `native … inline custom UI reproduces
clipping…` tests. Details in [verification](docs/verification.md).

## License

MIT — see [LICENSE](LICENSE).
