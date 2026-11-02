# Workflow todo

> Part of [pi-workflow-extensions](../README.md). An intent graph the agent reads, not a compliance record it services.

Tools: **`todo_plan`**, **`todo_act`**, **`todo_next`**. Command: **`/workflow-todos`**.

The v1 `workflow_todo` tool is still registered as a translating shim for one version; see [The v1 shim](#the-v1-shim). Everything else on this page is the current surface.

**Keyboard details:** press **Alt+W**, release, then **T** for todos, **S** for subagents, or **E** for artifact details (no Enter). **Esc** cancels the prefix menu. `/workflow` opens the same menu. Todo details open as a bordered picker that drills into a bordered markdown detail popup (`↑↓/jk`, `Enter`, digits `1`–`9`, `Esc`). This keyboard path works in regular and fullscreen TUI modes, including when `/sidebar off` hides the rail; terminal mouse clicks work only in fullscreen. The prefix is registered by `extensions/sidebar.ts`; the standalone todo extension retains `/workflow-todos`.

## The model in one paragraph

A plan is working memory, not a permission slip. The board — what may be worked on **now** — is a projection of the event log. Statuses that describe the world (`ready`, `blocked`, `waiting`) are **derived** from dependencies and live claims, never declared by the model. Completion is checked when the harness can check it, and marked honestly unverified when it cannot.

## Three tools, one purpose each

| Tool | Does |
| --- | --- |
| `todo_plan` | Declares intent: a goal plus tasks with optional `deps` and an exclusive `resource`. Re-declaring an unchanged goal keeps settled tasks and adds new ones. |
| `todo_act` | The only transition: `claim`, `done`, `failed`, `dropped`. |
| `todo_next` | Read-only. What is ready, what is claimed, what is blocked and by what. Pass `id` for one task with its evidence. |

Use them for multi-step or long-horizon work. Skip all three for a request you can finish in one step — there is no assessment round-trip.

### Stored vs derived state

Stored statuses are exactly `open`, `claimed`, `done`, `failed`, `dropped`. There is no stored `blocked` or `waiting`:

- **ready** — open, deps done, no live claim on its `resource`.
- **blocked** — open with an unfinished dependency.
- **claim expired** — claimed, but the lease ran out; the task is claimable again.

### Claims are leases

`claim` takes a `ttlMinutes` lease (default 30). A live claim reserves its task and its `resource`; an expired claim returns the task to the frontier. One claim per resource, so two tasks that name the same `file:` cannot be worked at once.

### Evidence is typed, and checked where it can be

`done` requires at least one ref:

```json
{"kind":"file","path":"extensions/todo.ts"}
{"kind":"test","name":"todo shim regressions","pass":true}
{"kind":"cmd","cmd":"npm test","exit":0}
{"kind":"artifact","id":"migration-plan"}
{"kind":"commit","sha":"8b72889"}
{"kind":"url","url":"https://example.com/issue/42"}
```

`file` and `test` are **verified** by the harness (`file` on disk, `test` by its recorded result). `cmd`, `artifact`, `commit` and `url` can only be **attested**: re-running a command or resolving a commit is the caller's job, so claiming "verified" for them would be the same dishonesty this model exists to remove. A completion with no verified ref is labelled `done (unverified)`.

### Scope

`committed` (default) survives the turn, is re-injected once per turn as a single line, and is the only kind that may gate a completion report. `scratch` lives and dies inside the turn that created it, so the common request pays nothing.

### The one remaining guard

While a committed plan has unfinished tasks, `agent_done` is refused with the list of open ids. That is the only place a todo blocks another tool. There is no "assess before any work tool" gate, no `adminRounds`/`loopSteers` loop police, and no refusal of `list`/`continue`.

### Claim hygiene

A claim is a promise, not progress. If a turn ends with a live claim and no settlement, the agent gets **one** model-visible reminder per claim. It never repeats for the same claim, so it cannot become a loop.

### Persistence

State lives in Pi session custom entries, reconstructed from the **active branch**, not a global file. Reload, resume, fork/tree navigation, and normal compaction retain the plan. Separate sessions have independent state, and a Herdr child does not inherit its parent's plan.

## The v1 shim

`workflow_todo` translates the v1 surface onto the three tools for one version, so an in-flight session keeps working. It is a **translation, not a bypass**: every non-open state goes through the same `refusal`/`applyTransition` path as `todo_act`, so a v1 call cannot produce a state the graph forbids. Rejections are atomic — a refused call writes nothing.

| v1 call | Translation |
| --- | --- |
| `{"todos":[…]}` (no action) | Treated as `sync`, as documented in v1. |
| `plan` | Creates a plan; all steps start `open`. |
| `sync` | Rebuilds the checklist by title, preserving `deps`, `resource` and settled work that the array omits. `in_progress` claims with a lease; only one may be `in_progress`. `done` requires `evidence` text. `cancelled` drops. |
| `update … done` | Requires `evidence` text; recorded as **attested**, never verified. |
| `update … in_progress` | Claims with a lease, validated against deps and resources. A `done` task cannot be silently reopened. |
| `update … blocked/waiting` | These are derived in v2, so the reason is kept as a note and the stored status stays honest. |
| `update … pending/cancelled` | Releasing a claim is a reopen; use `todo_plan`. `cancelled` drops. |
| `modify` | Edits the title, note, and `activeText` (shown while the task is claimed). |
| `add` | Appends a task, keeping existing ids and settled status. |
| `cancel` | With `id`, drops that one task; without, drops all unsettled. |
| `skip` | No-op. There is no gate to satisfy. |
| `list` / `continue` | Read-only report. |
| `offset` / `autoAdvance` | Accepted and ignored; there is no paging or auto-advance in v2. |

Dropped on purpose, because they were the bug: the assessment gate, `adminRounds`/`loopSteers`, stored `blocked`/`waiting`, free-text evidence treated as proof, `done` without a resolvable ref, and re-syncing a whole array to move one item.

## Limits

This is a workflow aid, not a permission sandbox or a proof of correctness. It enforces the declared plan's structure, not the truth of the agent's evidence. `cmd`, `artifact`, `commit` and `url` are attested only. The claim reminder is capped at one per claim and never continues errors or aborts.

To drop removed scope explicitly:

```text
/workflow-todos cancel requirements changed
```

The event log keeps every dropped task, so the decision stays auditable.
