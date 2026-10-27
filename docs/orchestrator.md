# Orchestrator: delegated work

> Part of [pi-workflow-extensions](../README.md). The author → spawn → check → review loop, its gates, and the escalation ladder.

Mode: **Orchestrator** (`/mode orchestrator`). The supervisor decomposes a large request into work units, delegates each to a cheap-model child with a handoff spec, runs them in parallel, reviews the results with evidence, and escalates only what it cannot decide.

## Lifecycle: product manager → workers → QA

The orchestrator is a product manager, not a reviewer career. Three phases, then it
waits:

1. **Spec — orchestrator + one devil's advocate, once.** Investigate with at most one
   research child. Author the spec as a workspace artifact. Run `orch_spec_review`
   once (the `single` preset: one merged `gate` lens); `quick` and `architecture` are
   explicit, expensive opt-ins. Resolve every finding (fix / accept with rationale /
   contest), re-author the handoff with `designRef`, and move on. A round must dispose
   of the previous round's findings; at most two non-ready rounds per target and three
   per session, cancelled rounds included. Past that the decision is the user's.
2. **Execute — workers in parallel lanes.** One `orch_handoff` per work unit, then
   `orch_spawn`. The spec is frozen here; it is never re-reviewed.
3. **QA — parallel result review with immediate defect routing.** On each worker
   completion, one QA child judges the RESULT against the frozen criteria
   (`orch_spawn({ purpose: "review", qaFor: "<scope>" })`), or the whole wave is
   fanned out at once with `orch_qa({ scopes: [...] })` — at most 3 reviewers,
   3 units each (see [waves](#waves-worker-and-qa-concurrency)). A defect pings the
   orchestrator at once; the orchestrator opens a ticket on the todo ledger
   (`todo_plan`, resource = the defective file), claims it, spawns a defect-scoped
   fix unit, and resumes the QA. QA pass → `todo_act done` with evidence; still
   failing → `todo_act failed` (reopen; twice → the user). Other results keep being
   reviewed in the meantime.

## Waiting: triggers, not timers

After a spawn, a review start, an escalation answer or a ticket transition, the
parent **ends its turn**. It is re-triggered by the child's completion report, its
question (escalation), or a watchdog budget/stall notice. It never sleeps and never
polls: `bash sleep` is not in the read-only grammar, and a repeated status/collect
call with no new event is answered with one line. Idle is the normal state.

**The loop:**

1. **Author** — `orch_handoff` writes one spec per work unit (scope slug, goal, acceptance criteria, lane files, out-of-lane files, interfaces, guidance) and publishes it as a **scoped artifact**. A child recalls its spec by id and sees nothing else: no sibling scope, no sibling path.
2. **Delegate** — `orch_spawn` takes a `handoffId` (spec work), or runs an **ad-hoc** child with `purpose`, optional `laneFiles`/`acceptanceCriteria`, and `budgetMinutes` (default 30). The child runs in its own Herdr pane; workers with disjoint lanes run in parallel. Purpose is resolved before any pane exists, so a refused spawn leaves no trace.
3. **Steer** — `orch_steer` (Esc→settle→type→observe delivery, confirmed by echo), `orch_route` (deterministic owner resolution), `orch_interrupt`/`orch_resume`. `orch_running` reports every child with scope, lane, and pending escalations.
4. **Review** — `orch_review` records each criterion against evidence the orchestrator gathered itself; an approved verdict with a failing criterion or an out-of-lane diff is refused in code. Two consecutive `revise` rounds stop the loop and move the decision to the user.
5. **Escalate** — `orch_escalate` is the ladder: `answer` / `to-user` (through the ask-user extension — a cancelled dialog is unanswered, never consent) / `relay-user` / `cancel`.

### The flow

Every gate below is enforced in code, not by prompt text — and a refused step writes nothing: no
registry row, no pane, no ticket.

```mermaid
flowchart TD
    req(["Request"]) --> author["1 · orch_handoff<br/>scope · criteria · lane · dependsOn"]
    author --> design{"ready spec review?"}
    design -->|"no designRef in Orchestrator/Supervise"| refuseA(["refused — nothing written"])
    design -->|"ready, or not required"| deps{"dependsOn approved?"}
    deps -->|"no"| refuseB(["refused — dependency-unapproved"])
    deps -->|"yes"| spawn["2 · orch_spawn<br/>purpose · budgetMinutes"]
    spawn --> admit{"admission"}
    admit -->|"depth · breadth · scope busy · orchestrator paused"| refuseC(["refused — no row, no pane, no ticket"])
    admit -->|"admitted"| work["3 · worker in its own pane<br/>its handoff artifact is its only spec"]
    work -->|"orch_ping"| ladder{"4 · escalation ladder"}
    ladder -->|"orchestrator knows"| answer["orch_escalate answer"]
    ladder -->|"does not know"| user{"ask the user"}
    user -->|"answered"| answer
    user -->|"cancelled is not consent"| blocker(["child reports the blocker"])
    answer -->|"resume"| work
    work -->|"orch_done"| check["5 · orch_check<br/>lane from git · declared verifyCommand · receipt"]
    check --> review{"6 · orch_review"}
    review -->|"failing criterion · out of lane · prose only · unreadable tree · substituted check"| revise["revise"]
    revise -->|"round 1–2"| work
    revise -->|"round 3"| handOver(["decision moves to the user"])
    review -->|"evidence per criterion verified · lane computed · receipt, if cited, valid"| approve["approved"]
    approve --> settle["verdict recorded · evidence bound to the scope"]
    settle --> record[["artifact: review-SCOPE"]]
```

**Specification review runs in front of implementation**, and the handoff carries the reviewed
revision, so an approval cannot transfer to text nobody read:

```mermaid
flowchart LR
    start["orch_spec_review start"] --> pin["pin by content hash<br/>+ machine lint"]
    pin --> lenses["one isolated reviewer per lens<br/>default single: gate<br/>quick: comprehension + readiness<br/>architecture: + critic + zoom-out"]
    lenses --> collect["collect<br/>reports bound to lens and revision"]
    collect --> resolve{"resolve dispositions"}
    resolve -->|"blocker open · fix applied · missing context"| start
    resolve -->|"ready"| ref["designRef: runId + targetHash"]
    ref --> handoff["orch_handoff carries designRef"]
    handoff --> spawn["orch_spawn re-reads the content"]
    spawn -->|"drifted or not ready"| refused(["refused"])
    spawn -->|"matches"| worker(["worker starts"])
```

**Child lifecycle** — these are the statuses the registry persists, so a restart reconciles
instead of guessing:

```mermaid
stateDiagram-v2
    direction LR
    [*] --> running: spawn admitted
    running --> blocked: orch_ping — question
    blocked --> running: answer delivered · orch_resume
    running --> completed: orch_done
    running --> failed: pane ends without orch_done
    running --> closed: orch_close · pane gone · /orch-pause (closeReason=paused)
    completed --> running: orch_resume
    failed --> running: orch_resume
    completed --> closed: orch_close
    failed --> closed: orch_close
    closed --> running: orch_resume (a paused close is redeployed)
    closed --> [*]
```

A pause is not a status: `/orch-pause` closes the row with `closeReason: "paused"`, and
`orch_resume` redeploys it. Reviewing a child records a verdict; it does not close the child —
`orch_close` does that.

**Durability.** The registry persists to an atomic versioned sidecar (`orchestrator-registry.json`) and is restored + reconciled on session start: dead panes are closed, live panes keep running, pending escalations survive. A watchdog enforces each child's wall-clock budget and stall-detects when the pane has not changed **and** the child's session file has not been written for ~90s — interrupting and steering the parent instead of burning tokens, without interrupting a child that is quietly running its test suite. `orch_running` lazily re-verifies pane liveness, so a child whose pane died never lingers as a zombie triggering cleanup loops across sessions; `orch_resume` refuses session paths that do not exist.

### Spawn shapes and mode policy

`purpose` is resolved before any registry row or pane exists. A refused spawn writes nothing.

| `purpose` | Normal | Plan | Child policy |
|---|---|---|---|
| `research` (Plan default) | ✅ | ✅ | read-only tools + `bash`/web inspection; no `write`/`edit`/patch |
| `review` | `orch_qa` / `qaFor` | `orch_qa` / `qaFor` | isolated reviewer: read-only research, `shell_read`, scoped evidence; no write/edit |
| `spec` (`handoffId`) | ✅ | ✅ | worker allowlist, lane frozen |
| `adhoc` (Normal default) | ✅ | ❌ | worker allowlist; no lane unless declared |
| `implementation` | ✅ | ❌ without an execution approval | worker allowlist |

Plan is read-only for the **parent**; delegating research, review or spec work is not implementation. Plan refuses `adhoc` and `implementation` with an explicit message. `orch_check` reports `lane: not-declared` for an ad-hoc unit with no `laneFiles` (it is not a failure), and `orch_review` treats an empty lane as "nothing to violate".

A delegated child may not spawn again (`PI_SUBAGENT_DEPTH`, default max-depth 1), and one parent may hold at most 8 running children (`PI_SUBAGENT_MAX_CHILDREN`). Both are hard stops before a pane exists and both are overridable.

### Waves: worker and QA concurrency

A wave runs in two tiers: at most **5 concurrent workers** (`spec`, `implementation`, `adhoc`), then at most **3 QA reviewers**, each judging at most **3 units**. These caps are concurrency, not lifetime quotas — a completed child frees its slot, which is what makes wave → review → next wave work. Research readers are not workers and hold no slot; a running specification reviewer is not QA and holds no QA slot, so a live spec review cannot silently halve QA capacity.

```text
orch_qa({ scopes: ["a", "b", "c", "d", "e"] })
  → qa-1 judges a, b
  → qa-2 judges c, d, e
```

The split is balanced with the remainder on later groups, and each reviewer gets a batch ticket naming only its own units, criteria, lanes and verify commands — a finding never crosses verdicts. Capacity is checked for the whole batch before the first pane opens, so a wave is never half-reviewed. `orch_spawn({ purpose: "review", qaFor: [...] })` is the manual single-reviewer form; `orch_qa` is the wave form. Labels are `qa-1…qa-K` and are reused once an earlier reviewer is closed.

### Which model and system prompt a child runs on

Three child roles can be bound to a model: `devil-advocate`, `worker`, and `qa-review`. A binding is `inherit` (follow the parent), one provider-qualified model, or a pool rolled **once per spawned child** — a pooled panel is diverse by construction, and a resume replays the recorded roll instead of switching mid-task.

```text
/orch-model                                  # role menu, then the picker
/orch-model worker                           # picker, current binding pre-ticked
/orch-model worker zai/glm-5.3-flash,deepseek/deepseek-4.1-flash   # text form
/orch-model --project worker inherit         # write the project file instead of the global one
```

Each role also has a **system prompt**, resolved per workspace: `.pi/orch-agents/devil-advocate.md`, `worker.md`, `qa-reviewer.md` (the role-id alias `qa-review.md` is accepted), then a global file under the agent dir, then a built-in default. The prompt is passed as a real `--append-system-prompt` file, so pi's own prompt stays and the role brief refines it.

```text
/orch-prompts                 # role → source (project | global | builtin) and path
/orch-prompts init            # write the three defaults; never overwrites authored content
/orch-prompts init --force    # regenerate them
```

An empty file falls through instead of silencing the role. Worker prompts apply to `spec`, `implementation` and `adhoc` children, `qa-reviewer.md` to QA reviewers, and `devil-advocate.md` to every lens of a spec review; research readers are unchanged.

Candidates come from the live model registry, so a provider added in pi appears with no code change. Bindings persist in `subagents.json` as `{ provider, model }` (project wins over global) and are read tolerantly: one malformed role never discards the rest. Precedence is explicit `model` argument → role binding → agent profile → global default; `inherit` passes no `--model` at all. A binding whose model vanished from the registry falls back to the next pool member, then to inherit, and every spawn/review result names the model and why it was chosen. Worker bindings cover `spec`, `implementation` and `adhoc` children; `research` readers keep the default and stay cheap.

### Research surface (read-only)

The orchestrator and the devil's advocate can research the web and learn the codebase without a
writer. The tool surface is deliberately narrow on the write side and wide on the read side:

| Concern | Tools | Guarantee |
| --- | --- | --- |
| Web | `web_research`, `web_fetch`, `web_read` | every source carries `url`, `fetchedAt`, `sha256`, excerpt; content is untrusted data |
| Codebase | `code_map`, `code_search`, `code_read`, `read/grep/find/ls`, `ffgrep/fffind` | path-scoped; control-plane state stays denied |
| History | `shell_read` | closed grammar (`git status/log/diff/show`, `rg`, `find`, `cat`, `wc`); no redirection, heredoc, `$()`, or unknown commands |
| Evidence | `artifact_save/edit/recall` | scoped to `review:<runId>:<lens>` or `orch-research:<scope>`; `artifact_search/list` stay denied for reviewers |

Search is engine-backed, never a JavaScript directory walk: `rg --json` → `git grep` → `grep -r`,
spawned with an argv array at most two at a time, with a 10 s timeout that returns partial results.
`ffgrep`/`fffind` remain available directly for fast interactive lookups; `code_search` prefers the
structured engine because it needs context and stable `path:line:column` citations. `code_read`
returns a line-numbered window plus a whole-file digest, so a review can cite the exact revision it
read.

Budgets are per child: 6 web searches, 20 pages and 200k characters; 50 code searches, 100 reads
and 2 MB. Fetched pages are cached in scratch for 10 minutes, so a re-read costs no network call and
deleting the scratch directory is always safe.

Research may write scratch (page cache, index) only under `.pi/orch-research/<run>/` — `.pi/` is
gitignored — falling back to `$TMPDIR/orch-research/<run>/` when it is not, and `PI_ORCH_SCRATCH`
may relocate it. The repository itself is never a write target, and scratch is bounded (50 MB,
10-minute cache TTL, 24-hour stale GC). Scratch is created lazily on the first cached fetch: a
session that only searches code never writes disk at all. Artifacts are the durable channel; scratch
is disposable.

### v1 removal and cut-over

The old `subagent*`, `caller_ping` and `parent_*` names are **removed**, not aliased. Everything is `orch_*`; `/subagents on|off|status` is the single switch, and `lib/delegation-tools.ts` is the single capability table. A stale global install that registers a v1 name is stripped from the active set and refused at call time. A v1 child launched before the migration must be finished or closed before reloading: resuming it would call a tool that no longer exists.

**Commands:** `/orch status | list | handoffs | escalations`, `/orch-model`, `/orch-prompts`.
`orch_qa` is a tool, not a command: the parent calls it to fan a wave out to QA.

### Independent specification review (opt-in)

Reviewing only the finished diff catches problems after they are expensive. `orch_spec_review` puts an independent, **read-only** review in front of implementation:

```text
orch_spec_review({ action: "start", targetArtifactId: "retry-design" })
  → pins the document by content hash, launches one isolated reviewer per lens
orch_spec_review({ action: "collect", runId })
  → reads their reports; every finding is bound to its lens and revision
orch_spec_review({ action: "resolve", runId, dispositions: [...] })
  → records how each finding was handled; readiness settles only when no blocker is open
```

Presets: `quick` (comprehension + readiness) and `architecture` (zoom-out, comprehension, critic, readiness). A reviewer gets a snapshot quoted into its ticket, `read`, named-path search, the todo tools, and `orch_spec_review_submit`, plus the read-only research surface: `code_map`/`code_search`/`code_read`, `web_read`/`web_research`/`web_fetch`, and `shell_read` (the closed grammar). It may write **evidence artifacts** scoped to `review:<runId>:<lens>` (`artifact_save/edit/recall`) — never a user artifact, never the work tree. It has **no** write/edit/patch, **no** general shell, **no** artifact discovery (`artifact_search`/`artifact_list`), **no** parent transcript pointer, and it is forced to `standalone` so an agent profile cannot widen its context. Broad search without a path and control-plane reads are refused; checkpoint and parent-brief injection are suppressed. That is enforced by the launcher and the parent's `tool_call` guard, not by prompt text. Review-ready is not human approval: the user still authorizes implementation. See [the role contract](#role-contract).

Bind the result to the work unit with `designRef`, and the gate refuses a stale approval at both ends:

```text
orch_handoff({ scope, …, designRef: { runId, targetHash } })   // refuses an unready or amended design
orch_spawn({ handoffId, … })                                    // re-reads the content and refuses drift
```

**Check receipts.** `orch_check` now returns a `checkRunId`. `orch_review({ …, checkRunId })` refuses a verdict when the receipt is missing, belongs to another scope, was taken against different acceptance criteria, or was taken against a different tree. Without a receipt, `cmd`/`test` evidence is still accepted as *attested* (shape-verified) — the difference is now visible in the audit trail instead of being indistinguishable from a real run.

**Known limitations:** receipts live in memory for the process that observed the run (a restart cannot vouch for work it did not watch); `treeDigest` covers the whole worktree, so two lanes in one checkout invalidate each other's receipt; reviewer isolation is harness isolation, not an OS sandbox.

Tests: `node --test tests/orchestrator/*.test.ts`.

## Role contract

| Role | Context | May change | Purpose |
| --- | --- | --- | --- |
| Elephant (Orchestrator parent) | full session, artifacts, repository | specs and control plane; no product code in Supervise | decompose, delegate, verify |
| Goldfish (spec reviewer) | pinned snapshot, permitted paths, read-only web/code research | its report and scoped evidence artifacts | independent judgement |
| Worker | exactly one handoff/ticket | its lane | implement and verify |
| QA reviewer | completed units, frozen criteria, read-only research | verdicts and scoped evidence artifacts | judge the result, not the spec |

An ordinary Normal or Plan child is a worker, not a Goldfish. Goldfish is a
mechanism — a fresh `standalone` session with a spec-only policy and no author
channel — not a persona name.

## Review-ready, human-approved, implemented

These are three different facts:

- **Review-ready**: every launched lens filed a complete report and no blocker or
  missing-context finding remains open.
- **Human-approved**: the user authorized implementation. Review readiness is
  never consent; a cancelled dialog is not consent either.
- **Implemented**: a worker changed its lane and verification passed.

A revised spec needs a fresh review. Approving a stale snapshot is refused at
both the authoring and spawn ends.

## Supported subset

Ported: pinned artifact/file review, the four review lenses, direct reviewer
dispatch, findings and dispositions, stale-review detection, `designRef`
admission, and read/write separation between roles.

Not ported: upstream skills/commands, the staged scheduler and review UI,
bootstrap/drift machinery, and every upstream persona. The four lenses are
implemented here as rubrics plus prompts; adding a lens is not a framework port.

Reviewer context is the ticket's pinned text, explicitly named references, and
the read-only research surface (`code_map`/`code_search`/`code_read`,
`web_read`/`web_research`/`web_fetch`, `shell_read`). Reviewers get `read`,
named-path search, todo tools, the submit tool, and scoped evidence artifacts
(`artifact_save/edit/recall`); `artifact_search`/`artifact_list` stay denied. A
search with no path is refused because it can walk control-plane state; a
reviewer cannot read the registry sidecar even when it lives under the working
tree. Checkpoint snapshots and parent briefs are suppressed for spec-only
reviewers.

## Audit targets

All audit targets below are implemented and covered by regression tests:

- Reject partial reviewer policy instead of treating it as an ordinary worker.
- Refuse generic reviewer resume/author-answer routes before side effects; fresh
  isolated review attempts are the recovery path.
- Block readiness on blocked/incomplete reports and unresolved missing context.
- Require ready matching spec reviews for Orchestrator implementation admission,
  including resume; Normal delegation is unchanged.
- Inspect real reviewer context and filesystem search boundaries; no parent
  pointer, no checkpoint injection, no broad search, no control-plane reads.
- Research tools are path-scoped and engine-backed; a search never walks the
  tree in JavaScript, and a timed-out engine returns partials with a warning.
- Reviewer writes are artifact-only and scope-checked (`review:<runId>:<lens>`);
  the work tree has no writer, and foreign/unknown artifact ids are refused
  identically.

Review-ready is not human execution approval. Ordinary user authorization to
implement is still required; a model-authored boolean is not proof of consent.
