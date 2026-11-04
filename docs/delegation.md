# Delegation: parent, child and handoff

> Part of [pi-workflow-extensions](../README.md). How a parent agent spawns child agents, what a handoff is, who owns the result, and every guardrail that is enforced in code.

## Definition

| Term | Meaning |
| --- | --- |
| **Parent Agent** | the agent that spawns a child agent. It owns the work, the budget and the verdict. |
| **Child Agent** / **Subagent** | the agent that is spawned by a parent agent. It sees its own handoff and nothing else. |
| **Handoff** | the document a parent sends a child, and the report a child sends back. |

Both modes have both roles: Normal and Plan can each spawn, and a child is a child in
either one.

## General purpose: not just coding

Delegation is a general parent → child mechanism. Code is one kind of work. A child
can research a question, draft a document, analyse a dataset, review another child's
output, or compare options — anything that can be stated as a **handoff**, delivered as
a **report**, and judged against **criteria**. The machinery never assumes a repository:

| Concern | Code work | Research / writing / analysis |
| --- | --- | --- |
| Handoff | assignment + `laneFiles` + criteria | assignment + criteria; **no lane** |
| Deliverable | changed files + `report-<scope>-<n>` | the report artifact itself (and any artifacts it cites) |
| Evidence the parent cites | file paths, commands | artifact ids, source URLs, paths |
| Receipt | report present, no write outside the lane (tool calls **and** the working tree) | report present, no workspace write at all |
| Child tools | `worker` | `planner` (read-only, `web_research`, `web_read`, `shell_read`) or a `tools` list you choose |

A child with no lane is read-only by construction: any workspace write is a blocking
receipt issue, whichever tool made it. Worked examples:

```text
agent_spawn({ agents: [
  { name: "market", role: "planner", task: "Summarise the three leading approaches to X with sources",
    delegationReason: "independent research lane",
    acceptanceCriteria: ["names at least three approaches", "every claim cites a source", "states what is unknown"] },
  { name: "legal",  role: "planner", task: "List regulatory constraints on X in the EU",
    delegationReason: "independent research lane",
    acceptanceCriteria: ["each constraint cites the regulation", "flags where counsel is needed"] },
] })
```

Both lanes start in that one call, the run ends, and each report wakes the parent. The
parent accepts with one verdict per criterion, citing the report artifact (verified to
exist) and the sources (recorded as attested).

## Behaviour

Four rules. Each is enforced in code, not requested in a prompt.

1. **The parent is responsible for the child's result.** A finished child is not an
   accepted result. If the child did not do what the handoff said, the parent spawns
   again and asks for the part that does not match the **first** handoff. It never
   edits the handoff to fit what the child did — see
   [rework](#rework-spawn-again-against-the-same-handoff).
2. **A child cannot modify the handoff it was given.** `artifact_save` and
   `artifact_edit` on a `handoff-*` or `rework-*` id are refused in a child session.
   A wrong handoff is escalated with `agent_ping`, never corrected in place.
3. **A child reports before it ends** — with an artifact (`report-<scope>-<n>`) or a
   tool call (`agent_progress`, `agent_ping`, `agent_done`). Silence is not a report:
   a pane that ends without `agent_done` is `failed`, not `completed` (enforced for the `completed-user-exit` path; a missing `report-*` is a blocking receipt issue).
4. **A parent never waits.** No `sleep`, no polling loop, no `tail -f`, no `!sleep`.
   The parent ends its turn; the child's completion, its question, or the watchdog
   re-triggers it. `lib/delegation/wait-guard.ts` refuses the command in a parent
   session, in every mode, including behind `!`.

Delegation is **not a mode**. Normal and Plan both reach the same `agent_*` surface.
A mode narrows the **parent's** own tools; it never narrows what a child may exist
for. Leaving Plan is not a prerequisite for delegating, and no mode is required to
delegate at all. See [modes](modes.md).

## The loop

1. **Spawn.** `agent_spawn` writes a **frozen handoff artifact** and opens one child
   in its own Herdr pane. Purpose is resolved before any pane exists, so a refused
   spawn writes nothing: no registry row, no pane, no artifact.
2. **Work.** The child recalls its handoff by id, does the work inside its lane, and
   reports progress with `agent_progress`. Children with disjoint lanes run in
   parallel.
3. **Ask.** A child that cannot decide calls `agent_ping`. That pauses it and
   re-triggers the parent, who answers with `agent_escalate`.
4. **Report.** The child writes `report-<scope>-<n>` and calls `agent_done`. The
   completion arrives as a message that re-triggers the parent.
5. **Judge.** The parent records a verdict with `agent_accept_result`. A finished
   child is **not** an accepted result; the work-unit slot stays occupied until a
   verdict exists.
6. **Rework.** A missed handoff is answered by spawning again against the **same
   frozen handoff** plus the defect list — never by editing the handoff.

```mermaid
flowchart TD
    spawn["agent_spawn<br/>writes handoff-&lt;scope&gt;-1"] --> admit{"admission<br/>reason · depth · slots · batch · lane"}
    admit -->|"refused"| nothing(["nothing written"])
    admit -->|"admitted"| pane["child in its own pane<br/>recalls its handoff"]
    pane -->|"agent_ping"| ladder{"escalation ladder"}
    ladder -->|"parent knows"| answer["agent_escalate answer"]
    ladder -->|"parent does not know"| user{"ask the user"}
    user -->|"cancelled is not consent"| blocker(["child reports the blocker"])
    answer -->|"resume"| pane
    pane -->|"agent_done + report-&lt;scope&gt;-&lt;n&gt;"| verdict{"agent_accept_result"}
    verdict -->|"accepted<br/>checked evidence"| free["slot freed"]
    verdict -->|"changes-requested<br/>defects required"| rework["agent_spawn({ reworkOf })<br/>same handoff + defects"]
    rework -->|"round ≤ 2"| pane
    rework -->|"round 3"| user2(["the user decides"])
    verdict -->|"abandoned<br/>cleanup notes"| free
```

## The handoff is a document, not a prompt

`agent_spawn` authors the handoff as a **scoped artifact** before the pane exists:

| Artifact id | Authored by | Written by |
| --- | --- | --- |
| `handoff-<scope>-<n>` | parent | never rewritten |
| `report-<scope>-<n>` | child | the child's own report |
| `rework-<scope>-<n>` | parent | never rewritten |

- The child's launch ticket is a **pointer**: `artifact_recall({ id: "handoff-…" })`
  plus the lane, the criteria and the escalation ladder at a glance. The prose lives
  in the artifact, so a ticket stays cheap and the document has a version.
- The handoff is **frozen for the child**: `artifact_save` and `artifact_edit` on a
  `handoff-*` or `rework-*` id are refused in the artifact layer when the caller is a
  child session. A prompt is a request; this is a rule. A wrong handoff is escalated,
  not corrected in place.
- **Scope is the boundary.** A child inherits only global artifacts plus its own
  scope, so a sibling's handoff is filtered out before the child can see it. Distance
  in a prompt is not a boundary; absence from the catalog is.
- If the handoff cannot be written, the spawn is **refused before the pane opens**. A
  child that cannot re-read its brief is untraceable, and a pane with no handoff is
  exactly that.
- The row records the handoff id, so a verdict can cite the exact document it judged.

## The parent owns the result

A finished child is not an accepted result. Each row carries durable accountability —
owner session, batch, work unit, the accepted `delegationReason`, a review plan, and a
`resultRevision` that bumps whenever the result is superseded (resume, resettle,
watchdog restart), so a verdict cannot bind to stale output.

```text
agent_accept_result({ childId, disposition, resultRevision, summary, evidence?, integration, defects? })
```

| Disposition | Requires | Effect |
| --- | --- | --- |
| `accepted` | at least one **checked** evidence reference (a file you inspected, a command you ran, an artifact version you read) | releases the slot. The child's summary is not evidence. |
| `changes-requested` | at least one **defect**: the criterion that was not met and what you observed | the defect list becomes the brief for the next round |
| `abandoned` | cleanup notes | recorded as wasted work, not success |

Refusal codes cover the stale-verdict class: a verdict on live work, from the wrong
owner, against a superseded revision, or on an already-settled result is refused in
code. A repeated identical disposition is idempotent.

At settle time the parent gets **one** continuation per changed pending-result set
asking it to judge. After that the obligations stay visible in `agent_running`, but
settlement never loops and never reports unverified work as done. Accepting every
child is still not proof the combined change works: the parent owes one integration
verification across the lanes it accepted.

## Rework: spawn again against the SAME handoff

The rule, in the user's words: *if the child did not do what the handoff said, the
parent spawns again and fixes the part that does not match the first handoff.*

```text
agent_accept_result({ childId, disposition: "changes-requested", defects: [
  "Criterion 'retry budget is configurable' is unmet: it is a constant in src/api.ts:12.",
  "src/billing.ts was modified and is out of lane.",
], … })

agent_spawn({ reworkOf: "<childId>", delegationReason: "…", task: "…" })
  → handoff-api-2 quotes handoff-api-1 (v1) + the two defects
```

- The rework is admitted only when that child's recorded disposition is exactly
  `changes-requested`. Refusals write nothing: `rework-unknown-child`,
  `rework-not-requested`, `rework-handoff-missing`.
- The **original handoff is never edited**, so "what I judged" stays identical to
  "what the new child is judged by".
- A rework is the same work unit, so its round count carries forward on the row and
  is capped at **2** (`MAX_REWORK_ROUNDS`). A third round is evidence the handoff, the
  lane or the goal is wrong — a decision for the user.
- `agent_steer` and `agent_resume` remain the cheap path on the same child; a rework
  is the "spawn again" path, and both are offered when a verdict is recorded.

## Waiting: triggers, not timers

After a spawn, an escalation answer or a verdict, the parent **ends its turn**. It is
re-triggered by the child's completion report, its question (escalation), or a
watchdog budget/stall notice. Idle is the normal state.

This is enforced, not requested:

- `RETRIGGER_CONTRACT` states the contract in every result that starts asynchronous
  work, and says the run is ending rather than asking for it.
- **The run actually ends.** A repeated `agent_running` with nothing actionable
  returns `terminate: true`, so pi stops the run after the batch. Prose alone was not
  enough: session `01a19cd6` was told "your turn ends here" ten times and answered
  with forty `find` calls. A pending escalation or an undispositioned result is
  actionable, so that case keeps the turn — terminating there would strand the
  review duty the parent still owes.
- **A successful spawn (and resume) ends it.** `agent_spawn`, `agent_resume` and an
  answered escalation return `terminate: true`: the parent generates nothing while
  children work. pi skips the follow-up model call only when **every** result in the
  tool batch terminates, so independent lanes are launched with **one `agent_spawn`
  call carrying an `agents: [...]` array** (each lane has its own task, reason, lane,
  criteria and model; a lane that does not fit admission is refused with its reason and
  the parent keeps its turn). Parallelism therefore never depends on the model batching
  tool calls. Separate calls in one assistant message also work — they all run, then the run ends.
  Session `01a19d41` serialised because lanes were spawned across separate turns. A
  refused or failed spawn does not terminate; the parent has to react to it. A parent
  that spawns one lane per turn passes `moreSpawns: true` on every spawn except the
  last, which keeps the run alive for the next lane.
- `lib/delegation/wait-guard.ts` refuses a `bash` command whose **purpose** is to
  wait, in a parent session **while a child is in flight**: `sleep`, `wait`, `watch`,
  `tail -f`/`--follow`, an unbounded `ping`, and never-terminating
  `while true`/`until false`/`for((;;))` loops. Wrapping does not hide it — leading
  `VAR=` assignments, `sudo`/`env`/`nohup`/`time`/`timeout`/`xargs` (compared by
  basename), pipelines, `&&` chains and `bash -c '…'` are all descended into.
- The guard is **scoped** by `lib/delegation/live.ts` (`hasLiveDelegation`). Waiting
  for a service, a port or a build is work, and a parent with no child may wait: in
  session `01a19cd6` a `sleep 8 && docker compose ps`, run to let MySQL accept
  connections, was refused while that session had no child at all. Children are
  exempt for the same reason: a child waiting on its own build is doing its work.
- `lib/delegation/poll-guard.ts` refuses the **same read-only inspection** (the closed
  grammar of `lib/plan/plan-shell.ts`) more than three times while a child is in
  flight. That is the other half of watching a child: the lane is the child's
  workspace, not a progress channel — progress arrives as `agent_progress`
  checkpoints and the report. Work that merely takes time (`npm test`, `cargo build`,
  `pnpm install`, long `git` operations) is never counted, even when repeated.
- A repeated `agent_running` with no new event is answered with one line instead of
  the same page.

## Health, failure and the result receipt

All of this is machinery in the parent process (a 30s watchdog tick plus a settle
hook). None of it is a tool call, and none of it needs the parent's turn to be live.

**Health ping.** Each tick, per running child: pane liveness (`pane get`), the pane
tail, the transcript mtime, and the transcript's last assistant turn
(`lib/delegation/child-health.ts`). The pane cannot tell "working" from "stuck on a
429" — a retry countdown changes the tail — but the child's own session file can.

| Signal | Action |
| --- | --- |
| pane gone | row closed, parent told (`pane-gone`) |
| parent closes a pane | the parent's close is recorded before the pane closes; the watcher's report of it is dropped, so it is not told the child was killed |
| herdr unreachable | never closes; after 6 blind ticks (~3 min) the parent is told once, and probing continues |
| tail frozen **and** transcript frozen, 3 ticks | Esc + parked, parent told (`stall-detected`) |
| wall-clock budget spent | Esc + parked, parent told (`budget-exceeded`) |
| last assistant turn is an error that outlived pi's retry window and any provider retry-after | pane closed, row `failed` with the error class, parent told the remedy |

**Failure classes** (`lib/delegation/child-error.ts`, patterns taken from real
transcripts). A model error is a failure with a cause, **not** a question — the
child's `Subagent halted:` sidecar used to open an escalation, i.e. a 429 was handled
as something to answer.

| Class | Examples | Remedy handed to the parent |
| --- | --- | --- |
| `transient` | 429 at capacity, Connection error, fetch failed, 502, no response headers | `agent_resume` the same session after the wait |
| `quota` | usage limit reached, quota reached, hourly rate limit | do **not** resume the same model; resume with another `model` or ask the user |
| `auth` | invalid credentials, 401/403 | the user must log in again |
| `config` | provider not registered, model not supported | resume with a different model |
| `aborted` | operation was aborted | never treated as a provider fault |

**The receipt** (`lib/delegation/result-check.ts`). When a child settles, the parent
computes a mechanical comparison of the result with the frozen handoff and stores it
on the row; it is printed in the completion message.

| Issue | Tier |
| --- | --- |
| `report-missing` — no `report-<scope>-<n>` sidecar | **blocking** |
| `lane-violation` — a write/edit outside the lane (or any write with no lane) | **blocking** |
| `no-clean-exit` — pane exited without `agent_done` (also makes the row `failed`) | **blocking** |
| `ended-on-error` — last turn was a provider error | **blocking** |
| `criterion-not-reported` — a frozen criterion's words are absent from the report | advisory |
| `handoff-not-opened` — no `artifact_recall` of the handoff in the transcript | advisory |

`agent_accept_result` refuses `accepted` while a blocking issue stands, unless the
parent names each code in `overrides` and justifies it in `summary`.

**The verdict binds to the handoff** (`lib/delegation/verdict-check.ts`). When the
handoff froze acceptance criteria, `accepted` needs `criteria: [{ criterion, met,
evidence }]` — one verdict per frozen criterion (1-based number or exact text). An
uncovered criterion, an unknown one, or `met: false` is refused (an unmet criterion is
`changes-requested`). Evidence is checked where it can be: a path must exist inside the
working directory, an artifact id must exist; a command, a URL or free text is recorded
as **attested** and never as verified. Each met criterion needs one verified reference
unless `evidence-unverifiable` is overridden with a reason. The per-criterion checks
are stored on the disposition. Once every lane is accepted the parent is owed **one
integration check** (`integration_owed`, once per accepted set), with any working-tree
change no accepted lane owns listed.
`changes-requested` and `abandoned` are never gated. The receipt proves the result
*could* match the handoff; whether it does remains the parent's judgment.

**Working-tree check.** The receipt also catches writes made through `bash` (`sed -i`,
`>`, a generator script). A signature of every dirty path is taken at spawn and diffed
at settle (`lib/delegation/git-changes.ts`). A change is held against a child only when
neither its own lane, a sibling's lane, nor the parent's recorded writes account for it
(`unowned-change`, blocking); if the parent also ran shell commands in the window it
is advisory, because it may be the parent's doing. A directory that is not a git
repository yields no finding — unknown, never "clean".

**Recovery** (`lib/delegation/recovery.ts`) — machinery, not a parent decision, and the
parent is not woken for any of it:

1. `transient` → retry the same model, up to 3 times, backoff `15s·2ⁿ` (never below the
   provider's stated wait, capped at 10 min). A **stall** (`no response headers`,
   `fetch failed`, timeouts, dropped connections) skips this and fails over at once when
   another usable model exists, because retrying a silent endpoint only waits out the stall.
2. The model is the problem (`quota`, `config`, `auth`, or `transient` that keeps
   failing) → **fail over**: resume the same session on the next usable model of the
   role's pool (`/agent-model`), skipping every model that already failed this work
   unit, at most 3 failovers.
3. Nothing left (no pool, pool exhausted, cap reached) or an unclassifiable failure →
   wake the parent with the class remedy and the reason recovery stopped.

The schedule is persisted on the row (`recovery.dueAt`) and re-armed at session start;
the history (models tried, retries, failovers) travels across resumes. The row is
`failed` while it waits, but the settle hook treats a pending recovery as in flight.
A parent can still fail over by hand: `agent_resume({ sessionPath, model })`.

**Headless runs.** In `pi -p` / json / rpc without a UI the run would exit the moment it
settles, taking the watchdog and the recovery timers with it. `agent_before_settle`
holds the run open (a loop over in-memory state, **no model call**, capped at 6h,
`PI_DELEGATION_NO_HEADLESS_WAIT=1` disables it) until no child or recovery is in
flight; the children's reports are queued by then, so the final turn sees them.

**Budget.** `budgetMinutes` is the **soft** limit. A child whose transcript is still
being written at the soft limit keeps running (the parent is told once, no turn) up to
4× the budget; a quiet child is interrupted at the soft limit as before.

## Escalation: child → parent → user

A child that does not know asks. A parent that does not know asks the user. Nobody
invents an answer, and a cancelled dialog is never consent.

```text
agent_escalate({ id, action: "answer" | "to-user" | "relay-user" | "cancel", answer?, reason? })
```

`answer` is legal only while the question is addressed to the parent; once it has been
handed to the user, answering it here would silently override a decision that was
escalated precisely because the parent was not competent to make it. `to-user`
requires a reason. `cancel` resumes the child with an explicit **NOT-approved**
message, and the child must report the blocker rather than pick an interpretation.

## Admission and guardrails

Every guardrail below is enforced in code, in every mode, and a refusal writes
nothing.

| Guardrail | Rule |
| --- | --- |
| `delegationReason` | required, non-empty: the concrete benefit of a separate agent. Small, tightly coupled or coordination-heavy work belongs in the parent session. |
| Depth | a child may not spawn again (`PI_SUBAGENT_DEPTH`, default max 1). |
| Occupancy | a slot is held by a running, blocked **or awaiting-verdict** child. A verdict frees it. A deliberate close (`agent_close`, `agent_interrupt` with `close`, a cancelled scope) of a running child abandons its unit and frees the slot. A crash-style close (pane gone) leaves the unit pending, because a report may still exist. |
| Batch budget | a per-batch launch ceiling (default 4) that completion does not refill. A launch whose child never produced output (no assistant text or tool call) is refunded when it is released, within the batch it was charged to. `/agent batch` is the user-owned reset; a model must ask, never run it to bypass a refusal. |
| Credentials | a role pool rolls only among members that have credentials. A pool, or an explicit model, with none is refused before any pane or handoff exists. |
| Duplicate work unit | an occupied work unit is steered, resumed or settled — or replaced explicitly with `replaces` and capacity. |
| One writer per lane | a scope with a live child refuses a second spawn: two writers in one lane produce diffs nobody owns. |
| Handoff frozen | a child cannot rewrite its `handoff-*`/`rework-*` artifact. |
| Verdict evidence | `accepted` requires checked evidence; `changes-requested` requires a defect list. |
| Rework cap | at most 2 rounds per work unit, then the user decides. |
| No waiting | the parent cannot wait **on a child**, poll it, or follow it; a wait on a service or a build is work. |

Defaults are **2 occupied slots** and **4 launches per batch**. An explicitly
configured ceiling (`maxDelegates` from `/agent max`, `maxConcurrentDelegations`, or
`PI_SUBAGENT_MAX_CHILDREN`) is honoured: the strictest configured value wins, and the
defaults only fill unmapped slots. Launch admission is atomic — the slot is reserved
synchronously before the first await, so two spawn calls in one assistant message
cannot both pass the last-slot check, and a failed launch never eats capacity.

```text
/agent status | list | escalations | max [n] [--project] | batch
```

## Spawn shapes

`purpose` (or `role`) is resolved before any registry row or pane exists.

| Shape | Admitted | Child policy |
| --- | --- | --- |
| `adhoc` (worker, default) | ✅ every mode | worker allowlist; writes only inside its declared lane |
| `research` / `role: "planner"` | ✅ every mode | read-only reader: no `write`/`edit`/patch, no general shell, no parent surface |
| `spec`, `review`, `implementation` | ❌ | the spec-review/QA pipeline was removed; these values are refused with their successor named |

A planner produces a plan artifact (`plan-<scope>`); a worker executes a plan step
with `planId`/`stepId`, and the step supplies its lane and criteria.

## Child lifecycle

These are the statuses the registry persists, so a restart reconciles instead of
guessing.

```mermaid
stateDiagram-v2
    direction LR
    [*] --> running: spawn admitted
    running --> blocked: agent_ping — question
    blocked --> running: answer delivered · agent_resume
    running --> completed: agent_done
    running --> failed: pane ends without agent_done
    running --> closed: agent_close · pane gone
    completed --> running: agent_resume
    failed --> running: agent_resume
    completed --> closed: agent_close
    failed --> closed: agent_close
    closed --> [*]
```

Recording a verdict does not close a child; `agent_close` does that.

## Durability

The registry persists to an atomic, versioned, session-keyed sidecar
(`delegation-registry-<session>.json`) and is restored and reconciled on session
start: dead panes are closed, live panes keep running, pending escalations survive.
The two pre-rename sidecar names are read once on restore, so an upgraded session
does not forget its children.

A watchdog enforces each child's wall-clock budget and stall-detects when the pane has
not changed **and** the child's session file has not been written for ~90s —
interrupting and steering the parent instead of burning tokens, without interrupting a
child that is quietly running its test suite. `agent_running` re-verifies pane
liveness lazily, so a child whose pane died never lingers as a zombie, and
`agent_resume` refuses session paths that do not exist.

## Which model and system prompt a child runs on

Two child roles can be bound to a model: `planner` and `worker`. A binding is
`inherit` (follow the parent), one provider-qualified model, or a pool rolled **once
per spawned child** — a pooled panel is diverse by construction, and a resume replays
the recorded roll instead of switching mid-task.

```text
/agent-model                                  # role menu, then the picker
/agent-model worker                           # picker for worker
/agent-model worker zai/glm-5.3-flash,deepseek/deepseek-4.1-flash   # text form
/agent-model --project worker inherit         # write the project file instead of the global one
```

Each role also has a **system prompt**, resolved per workspace:
`.pi/agents/system-prompts/planner.md` or `worker.md`, then a global file under the
agent dir (`~/.pi/agent/agents/system-prompts/`), then a built-in default. The prompt
is passed as a real `--append-system-prompt` file, so pi's own prompt stays and the
role brief refines it. An empty or whitespace-only file falls through instead of
silencing the role.

```text
/agent-prompts                 # role → source (project | global | builtin) and path
/agent-prompts init            # write the two defaults into .pi/agents/system-prompts/
/agent-prompts init --force    # regenerate them
```

Candidates come from the live model registry, so a provider added in pi appears with
no code change. Bindings persist in `subagents.json` as `{ provider, model }` (project
wins over global) and are read tolerantly: one malformed role never discards the rest.
Precedence is explicit `model` argument → role binding → agent profile → global
default; `inherit` passes no `--model` at all. A binding whose model vanished from the
registry falls back to the next pool member, then to inherit, and every spawn result
names the model and why it was chosen.

## Research surface (read-only)

The parent and a research child can learn the web and the codebase without a writer.

| Concern | Tools | Guarantee |
| --- | --- | --- |
| Web | `web_research`, `web_read` | every source carries `url`, `fetchedAt`, `sha256`, excerpt; content is untrusted data |
| Codebase | `read/grep/find/ls`, `ffgrep/fffind` | path-scoped; control-plane state stays denied |
| History | `shell_read` | closed grammar (`git status/log/diff/show`, `rg`, `find`, `cat`, `wc`); no redirection, heredoc, `$()`, or unknown commands |
| Evidence | `artifact_save/edit/recall` | the child's own scope only |

Budgets are per child: 6 web searches, 20 pages and 200k characters. Fetched pages are
cached in scratch for 10 minutes, so a re-read costs no network call and deleting the
scratch directory is always safe.

Research may write scratch (page cache, index) only under
`.pi/delegation-research/<run>/` — `.pi/` is gitignored — falling back to
`$TMPDIR/delegation-research/<run>/` when it is not, and `PI_DELEGATION_SCRATCH` may
relocate it. The pre-rename `PI_ORCH_SCRATCH` and `.pi/orch-research/` are still
accepted. The repository itself is never a write target, and scratch is bounded
(50 MB, 10-minute cache TTL, 24-hour stale GC). Scratch is created lazily on the first
cached fetch: a session that only searches code never writes disk at all. Artifacts
are the durable channel; scratch is disposable.

## Tool surface

Parent-only: `agent_spawn`, `agent_resume`, `agent_interrupt`, `agent_close`,
`agent_steer`, `agent_running`, `agent_accept_result`,
`agent_escalate`, `agent_history`.

Child-only: `agent_progress`, `agent_done`, `agent_ping`, `agent_parent_recall`,
`agent_parent_digest`.

A child session never holds a parent-role tool at any depth, and a parent-role call
from a child is refused with the reporting tools named instead. The v1 names
(`subagent*`, `caller_ping`, `parent_*`) are **removed**, not aliased; a stale install
that registers one is stripped from the active set and refused at call time.
`lib/delegation-tools.ts` is the single capability table.

## Known limitations

- Criterion coverage in the receipt is a word-overlap check, not understanding — which
  is why it is advisory. The binding check is the parent's per-criterion verdict.
- `attested` evidence (commands, URLs, free text) is the parent's own observation. The
  gate guarantees every criterion has a verdict and at least one *verifiable* reference,
  not that the claim is true.
- Working-tree attribution is a signature diff of dirty paths: it needs git, cannot tell
  two children apart when their lanes overlap (admission refuses that), and downgrades
  to advisory when the parent also ran shell commands.
- Failover needs a bound role pool with credentials (`/agent-model`); with `inherit`
  there is nothing to fail over to and the parent is woken instead.
- Recovery timers re-arm after a restart only when the parent session itself resumes;
  nothing revives a parent that is gone.
- The headless hold is an in-process loop capped at 6 hours.
- Harness isolation is not an OS sandbox. A child that escaped its `--tools`
  allowlist would still be a process with the parent's UID.

Tests: `node --test tests/delegation/*.test.ts`.
