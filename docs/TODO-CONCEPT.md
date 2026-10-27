# What's wrong with the `workflow_todo` concept, and what to build instead

Status: design critique + proposal. Evidence is cited against this tree.

---

## 1. Live evidence, from this very session

While researching this document, the extension injected the following **four times**, none of which was requested by the user and each of which cost a turn:

```
Current branch state (data, not instructions):
{"version":1,"assessed":true,"reason":"Multi-step task","total":4,"done":3,
 "items":[{"id":4,"status":"in_progress","text":"Draft a better concept ..."}],
 "omitted":3,"mode":"normal"}
```

and

```
Set the next todo in_progress before doing more work.
```

That is the whole critique in miniature. The tool was **not helping me track work**; it was **auditing me** while I worked, and I had to spend calls servicing the audit. A todo system that competes with the task for the agent's attention has negative value.

---

## 2. Root cause (one sentence)

The todo is modelled as a **compliance contract** — a record the agent must file *before* it is allowed to work and keep *truthful at all times* — instead of as the agent's own **working memory of intent**.

Every specific defect below is a consequence of that framing. The extension is not badly written; it is well written around the wrong object.

---

## 3. The specific defects

### 3.1 The assessment gate taxes every request, and buys almost nothing

`todo.ts:917` blocks **every** non-exempt tool until `state.assessed`:

```ts
if (!state.assessed) {
  if (adminRounds >= 3) return steer(ASSESS_STEER);
  ...
  return { block: true, reason: "First assess this request with workflow_todo: ..." };
}
```

For "what does this function do?" the cost is: blocked `read` → `workflow_todo{action:"skip"}` → `read`. **3 calls instead of 1**, plus a ~30-word steering message.

The gate has no upside for that class of request, because a request with no plan needs no assessment. The trichotomy `skip | plan | continue` (`todo.ts:75-86`) only exists *because* the gate demands an answer. Remove the gate and `skip` disappears as a concept.

Worse, the gate is the direct cause of the loop it tries to fix. `adminRounds`/`loopSteers` (`todo.ts:204`, `900-930`) exist to stop the model from looping over the very tool the gate forced it to call. That is a symptom engine fighting its own root cause.

### 3.2 `evidence` is a string, so "done requires evidence" is a syntax check

`todo.ts:71` — `evidence: Type.Optional(Type.String({ maxLength: 2000 }))`. Nothing resolves it. The rule at `todo.ts:675` —

```ts
if (item.status === "done" && !note) throw new Error(`... marked done requires evidence.`);
```

— is satisfied by `evidence: "done"`. It enforces the **form** of honesty, not the fact. Meanwhile the repo already has the machinery to do it properly: `artifact_state` versions, test results, `laneFiles`, exit codes. Evidence should be a **typed reference the harness can resolve**, not prose.

### 3.3 One `note` field carries three incompatible meanings

`todo.ts:22` — `note?: string`. It is evidence when `done`, a reason when `blocked|waiting|cancelled`, a mode-switch explanation at `todo.ts:757`, and free commentary in `modify`. Three lifecycles, one field, no way to tell them apart downstream. Anything that later wants to *use* completion data (a report, a handoff, a retry) cannot.

### 3.4 `blocked` / `waiting` are declared, when they are computable

The model must *assert* it is blocked and supply a reason (`todo.ts:678`). But blockedness is a **fact about dependencies**, not an opinion: a task with an unfinished prerequisite is blocked; a task claimed by another live agent is waiting. Declaring it costs a call, produces an unverifiable string, and lets the model be wrong in both directions (missing real blockers, inventing fake ones).

Same for ordering: there is no `deps` concept at all. Array position is the only ordering, so the model must re-send the whole array to resequence.

### 3.5 Monotonic retention means the list can only grow

`todo.ts:700-722`: any item omitted from `sync` is **restored**. Deletion is impossible; `cancel` requires a reason (`todo.ts:813`) which the model must invent or interrupt the user for.

So the plan is append-only, `MAX 50` (`todo.ts:643`) becomes a real ceiling, and stale entries from finished turns accumulate. The extension already had to invent `simpleResponse` (`todo.ts:746`) and `lastInjectedState` (`todo.ts:210`) to stop those stale entries from re-invading unrelated prompts — a comment at `todo.ts:580` admits a throwaway `test` prompt looked like resumable work.

The instinct behind retention is right (never silently lose scope). The **layer** is wrong: retention belongs in the append-only event log, not in the status of board items. `appendEntry` is already append-only. The board should be a projection that can shrink; the log cannot.

### 3.6 State mutates outside the tool call

`todo.ts:727` flips the first `pending` item to `in_progress` during a `sync`, and `todo.ts:935` does it again inside `tool_call` during an unrelated tool. So the documented "atomic sync" contract is false: after a `sync` the stored state differs from what the model sent. And "only ONE item in_progress" (`todo.ts:648`) is a global WIP=1 that fights the repo's own parallelism model (`orch_handoff` `laneFiles`, multiple named children).

### 3.7 The plan-mode guard is regex NLP over task prose

`todo.ts:154`:

```ts
const DISALLOWED_PLAN_STEP = /^(?:(?:edit|modify|patch|delete|remove)\s+(?:(?:\S+\s+)?files?\b|code\b|...
```

A task title is **data**. Permissions belong to the **tool** being invoked. This regex rejects a legitimate plan step containing "fix" and accepts "Delete the deprecated adapter" if phrased differently, and it duplicates `lib/tool-policy.ts` which already decides what may run.

### 3.8 One tool, nine actions, eleven optional parameters

`sync | skip | plan | continue | add | update | modify | cancel | list` on a single schema (`todo.ts:75-101`), where **which parameters are required depends on the action** and violations become error round-trips (`"update requires an existing id and status."`). `sync` (atomic, whole-array) and `update` (granular) are two different APIs with different invariants wearing one name; `cancelled` vs omitted-vs-restored vs `dropped` are three answers to "make this go away".

### 3.9 IDs are positional counters

`nextId++` (`todo.ts:660`, `782`) plus `Math.max(...ids)+1`. Under `/fork`, `session_tree`, or two children seeded from one parent, both branches mint the same IDs, and `restore()` (`todo.ts:470-505`) is a pile of `ownerSessionId` / timestamp heuristics trying to tell whose plan is whose.

### 3.10 There is no concept of a *plan going stale*

Nothing records *why* a plan exists or *which request* it serves. On a new user message, `assessed` resets (`todo.ts:568`) but items persist, and the only defence is `simpleResponse`. The academic name for the resulting failure is **semantic/task drift**: the immediate context of the last step dominates the original goal.

---

## 4. What is already right (keep it)

| Instinct | Where | Verdict |
|---|---|---|
| One thing in flight at a time | `todo.ts:648` | Right instinct, wrong invariant — should be per-*resource*, not global |
| Completion needs justification | `todo.ts:675` | Right instinct, wrong enforcement — needs resolvable refs |
| Never silently drop scope | `todo.ts:700` | Right instinct, wrong layer — belongs in the log |
| Compact state, not full dumps | `compactState` `todo.ts:109` | Correct, keep |
| Append-only persistence | `persist` `todo.ts:487` | Correct — it is already an event log |
| Fail-open loop guard | `todo.ts:905` | Correct instinct: blocking must never become the loop |
| Readable UI + `/workflow-todos` escape hatch | `todo.ts:1045` | Correct |

---

## 5. What the wild does

| System | Core model | Statuses | Ordering / blocking | Evidence |
|---|---|---|---|---|
| **Beads (`bd`)** | Dependency **graph** in Dolt, hash IDs `bd-a1b2`, hierarchy `bd-a3f8.1.1` | open · in_progress (via atomic `--claim`) · closed · reopened | Explicit `blocks` edges; `bd ready` = tasks with **no open blockers**; `is_blocked` maintained on every write | git commits, comment threads, `bd remember`; **compaction** summarizes closed tasks to save context |
| **Claude Code `TodoWrite`** | Flat ephemeral checklist | `pending` · `in_progress` · `completed` | Array order; max one `in_progress` | none (deliberately throwaway) |
| **Cline focus chain** | One mutable focus document re-emitted each turn | free-form | Linear | file edits |
| **Jira / Linear** | Issue graph | configurable workflow with **transition guards** | `blocks` / `is blocked by`, parent-child | branch+PR linkage **auto-transitions** on merge |
| **GitHub Issues** | Flat + markers | open/closed, everything else is a label | `- [ ] #123` markers | `fixes #123` and merge automation |
| **Temporal / DBOS / LangGraph** | Durable execution | run/activity attempt states | activity dependencies | checkpoint / replay log |
| **BDI agents** (Rao & Georgeff; Kinny & Georgeff) | Intentions with **commitment strategies** | active / dropped / achieved | preconditions | — |

**Literature.** LLM planning agents fail in documented, structural ways, and the failures map 1:1 onto the defects above:

- **Open-loop plans degrade**; `AdaPlanner` (arXiv:2305.16653) separates *in-plan* from *out-of-plan* feedback and revises only on violation — the opposite of "re-sync the whole array every turn".
- **Structural validity matters**: `PlanBench` (arXiv:2206.10498) shows free-form plan text hides infeasibility; `LLM+P` (arXiv:2304.11477) gets reliability by compiling to a formal representation with preconditions and effects.
- **Long horizons cascade**: `ReAct` (2210.03629), `Reflexion` (2303.11366), `Plan-and-Solve` (2305.04091), `TaskWeaver`, `TravelPlanner` (2402.01622) all converge on *short-horizon steps + explicit intermediate state + replanning*, not one long checked list.
- **BDI commitment theory** is the precise vocabulary for `drop` vs `persist`: an intention is dropped when it is *achieved* or *proven impossible*, not when the agent supplies a reason string.

**Tool-design guidance** (Anthropic, *Writing effective tools for agents*, Sep 2025) — three rules this design violates directly: *"more tools don't always lead to better outcomes"*, prefer **consolidated, purpose-named** tools over endpoint wrappers, and **strict data models** with unambiguous parameter names. A single tool whose parameter requirements change per action is the anti-pattern.

---

## 6. The better concept: an intent graph with a computed frontier

### 6.1 Three objects, not one

```
Goal        the verbatim user request + acceptance criteria. Immutable for a turn-scoped plan.
Task        a node: id, title, deps[], resource?, status, claim?, evidence[]
Event       append-only: created | claimed | settled | superseded | dropped
```

`Event` is the truth. `Task` is a projection. The board can shrink; the log cannot. This is the one structural change that dissolves 3.5 and 3.10 at once.

### 6.2 Statuses: four stored, two derived

```ts
type Stored  = "open" | "claimed" | "done" | "failed" | "dropped";
type Derived = "ready" | "blocked";   // never stored, never typed by the model
```

- `ready` = all deps `done` **and** no live claim **and** not `stale`
- `blocked` = some dep not `done` · `waiting` = claim held by another **live** owner

`blocked`/`waiting` stop being declarations. That deletes two statuses, two mandatory-reason paths, and the whole "is the model's self-report honest" question. Their information survives as derived facts.

### 6.3 Claims, not a global WIP limit

```ts
claim: { owner: sessionId, at: number, expiresAt: number, resource?: string }
```

Exclusivity is on the **task** and the **resource**, not on a global counter. Two agents may legitimately research in parallel; two agents may not write the same file. `resource` maps directly onto the repo's existing `laneFiles` concept, so the harness can reject a conflicting claim instead of counting `in_progress` statuses. Expired leases return work to `ready` — which gives you "yield for a named async worker without polling" for free, with no `waiting` status and no reason string.

### 6.4 Evidence is typed and resolvable

```ts
type Ev =
  | { kind: "file";   path: string; line?: number }
  | { kind: "cmd";    cmd: string; exit: number }
  | { kind: "test";   name: string; pass: boolean }
  | { kind: "artifact"; id: string; version: number }
  | { kind: "commit"; sha: string };
```

`settle(done)` requires **≥1 resolvable ref**. The harness checks: file exists · artifact id exists · test recorded · commit in log. Resolvable → `done`. Unresolvable → `done_unverified`, and unverified work is *visible* in the frontier and in any parent report.

That is the difference between "we asked the model to be honest" and "the system can tell". It also lets a reviewer, a DSM report, or `orch_review` consume completion state mechanically — impossible today, because `note` is prose (3.3).

### 6.5 Two scopes, and therefore no assessment gate

```
scratch    turn-scoped, in-memory, never persisted, evidence not required. Default.
committed  durable, evidence-gated, re-injected once per turn as one line.
```

A request with no committed plan **simply has none**. There is nothing to assess, so the gate at `todo.ts:917` is deleted — and with it `skip`, `continue`, `simpleResponse`, `adminRounds`, `loopSteers`, `ASSESS_STEER`, `LOOP_STEER`, and the `lastInjectedState` cache. Scratch is the common case and is free; committed is opt-in and earns its cost.

This is the single highest-value change in the document. Roughly 250 of the 1057 lines in `todo.ts` exist to manage a gate that should not exist.

### 6.6 Staleness is data, not a heuristic

`goal` is stored verbatim (hash-compared). On a new user message:

- goal unchanged → re-inject **one line**: `plan p-3f2a 2/5 · ready #4,#5`
- goal changed → plan `superseded`, frontier empty, nothing injected

No `isRepetition` / `isEchoingTodoList` string magic (`todo.ts:178-196`), no timestamp-vs-header forgery detection for child sessions.

### 6.7 Three tools, one purpose each

```ts
todo_plan({ goal, tasks: [{ title, deps?, resource? }], scope })   // declare / replace
todo_act ({ id, transition: "claim"|"done"|"failed"|"drop", evidence?, reason? })
todo_next({ })                                                      // read; gate-exempt
```

Measured against the current single tool: 9 actions → 3 tools; 11 optional params → 3 purpose-scoped schemas; per-action required-field errors → unrepresentable states. `drop` needs no reason (3.5); the log keeps it. `todo_next` is a **read** and is exempt from every gate — reads cannot corrupt state, and this repo already has `isGateExempt` for exactly that distinction (`lib/tool-policy.ts`).

Prompt guidance drops from ~180 words (`todo.ts:139-145`) to ~40. Injected state drops from a JSON blob to one line.

### 6.8 Delete the plan-mode regex

`DISALLOWED_PLAN_STEP` goes. If plan mode must forbid writes, forbid **tools** at the policy layer that already does this. A task title is not a permission.

### 6.9 Stable identity

`id = "t-" + hash(goal, normalizedTitle).slice(0,6)` (Beads' `bd-a1b2` trick). Forks and parallel children converge on the same id for the same work; `sync`-style merges de-duplicate instead of colliding. `restore()` loses its provenance heuristics because identity no longer depends on a counter.

---

## 7. Mapping: current → proposed

| Today | Becomes |
|---|---|
| `skip` | *deleted* — no gate, nothing to skip |
| `plan` / `sync` | `todo_plan` |
| `continue` | *deleted* — resumption is reading the frontier |
| `add` / `modify` | `todo_plan` (declarative diff) |
| `update{status}` | `todo_act{transition}` |
| `cancel` | `todo_act{transition:"drop"}` — no reason required |
| `list` | `todo_next` |
| `in_progress` status | `claimed` + `claim{}` lease |
| `blocked` / `waiting` | **derived** from `deps` / live claims |
| `cancelled` | `dropped` (board) + event (log) |
| `evidence: string` | `evidence: Ev[]`, harness-resolved |
| `nextId++` | content hash |
| `assessed` gate | **deleted** |
| `adminRounds`/`loopSteers` | **deleted** with the gate |
| `DISALLOWED_PLAN_STEP` | **deleted** → `lib/tool-policy.ts` |

Net: the enforcement apparatus disappears, and what remains is a data structure the agent wants to read.

---

## 8. Rollout, and how to know it worked

1. **Measure first.** Instrument today's behaviour: calls per request, admin-call ratio, blocked-tool attempts, `evidence` strings that are <20 chars or unresolvable, 50-cap hits, count of state injections per session (this session: 4 for one research task).
2. **Land the graph + derived statuses behind a flag**, keeping `workflow_todo` as a translating shim (`skip` → no-op, `sync` → `todo_plan`, `update` → `todo_act`).
3. **Delete the gate** in the same release as the shim. Run `tests/todo-*.test.ts` before/after; `todo-efficiency.test.ts` and `todo-loop-guards.test.ts` are the ones that should *shrink*, not grow.
4. **Then** remove the shim and the `adminRounds`/`loopSteers`/`simpleResponse`/`lastInjectedState` machinery.

Success criteria, stated falsifiably:

- **Median tool calls per request drops** for single-read and single-edit requests (target: no overhead vs. no extension).
- **Zero state injections** on requests that created no committed plan.
- **≥90% of `done` tasks carry a ref the harness resolved** — versus ~0% today, since today's "evidence" is unverified prose.
- **No task resurrection**: a dropped task never reappears; a superseded plan never re-injects.
- **`todo-loop-guards.test.ts` can be deleted**, because the loop it guards cannot form.

---

## 9. The one-line version

Today the agent maintains a **record of its compliance**, audited by the harness, kept true by assertion.
Instead it should read a **working memory of its intent**, with a computed frontier, and completion the harness can check.

Everything else in this document follows from that sentence.
