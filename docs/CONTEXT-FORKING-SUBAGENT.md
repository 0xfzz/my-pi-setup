# Context-Forking Subagents — research, gaps, and implementation plan

| Field | Value |
| --- | --- |
| **Status** | historical audit + plan |
| **Detail for** | [README § Delegated-work checkpoints](../README.md) |
| **Scope** | `vendor/pi-herdr-subagents/`, `lib/subagent-context.ts` |
| **Verified against** | audited against Pi 1.3.0 and Herdr @ `9942203`, as stated below; not current |
| **Related** | [Implemented fixes](FIX-SUBAGENT-BUG.md) |

## Summary

- What the forked child actually inherits today, measured against the concept of a context-rich delegate.
- Gap analysis with line-level evidence, including smaller-model context budgeting (still a limitation).
- Design for three context shapes plus on-demand recall, with rollout, risks and non-goals.
- Superseded in part: read the implemented fixes first, then this for the reasoning and the open items.

See [`FIX-SUBAGENT-BUG.md`](FIX-SUBAGENT-BUG.md) for the implemented active-leaf/trailing-user fix, current mode synchronization, regression results, and remaining limitations. The gap descriptions and line references below describe the earlier audited baseline, not all current code. In particular, smaller-model context budgeting remains a limitation; do not treat every proposed item below as implemented.
(`~/.pi/agent/git/github.com/0xfzz/pi-herdr-subagents` @ `9942203`), `pi-vcc` 0.4.1.

---

## 0. The concept we actually want

The reference chapter ([harness-engineering-101 §07](https://github.com/IsuruMaduranga/harness-engineering-101/blob/main/src/07-subagents.md))
defines a subagent by its *context shape*, not by an org chart:

> A subagent is a second agent loop, run with a fresh, empty array, given one task,
> whose final answer is returned to the main loop as a tool result. Then its array is
> thrown away.

…and then adds exactly one production note that we care about here:

> **A fork variant.** One special child type starts with a *copy* of the parent's array
> instead of an empty one, so it has the full context but is still thrown away when it
> finishes. […] Both exist because each solves a different problem: fresh children save
> context budget, while forked children keep the parent's context.

We are **not** copying that implementation. We adopt three ideas from it and one of ours:

| # | Idea | Source |
|---|---|---|
| 1 | Fresh child is the default; fork is an *explicit, named* variant — never the silent default | chapter 7 |
| 2 | Fork is a **context** tool: the child's array is disposable, only its report returns | chapter 7 |
| 3 | Write the ticket for a contractor with no Slack — because a fresh child is deaf | chapter 7 |
| 4 | **A fork should be able to recall from its parent on demand**, not only inherit a frozen snapshot at t=0 (our addition; the chapter has no recall story) | this doc |

Idea 4 matters for us specifically because our children are **Herdr panes that stay alive and get resumed**
(`caller_ping` / `subagent_resume`). A long-lived child that drifted out of a snapshot is the normal case
here, not the exception, so "inherited once, never refreshed" is a worse design for us than it is for a
single-shot toy harness.

---

## 1. What we have today (baseline, with evidence)

### 1.1 Launch side lives in Herdr, not in this package

This repo ships the *companion* (checkpoints, artifacts, todo, modes) — it does **not** launch children.
The fork machinery is upstream, in `pi-herdr-subagents`:

| Mechanism | Location |
|---|---|
| `fork?: boolean` tool param ("Force the full-context fork mode") | `index.ts:431-436` |
| `/iterate` — the only user-facing fork entry point | `index.ts:1117-1127` |
| `sessionMode: "standalone" \| "lineage-only" \| "fork"` frontmatter parsing | `src/agents.ts:27`, `:120-125`, `:206-212` |
| `fork: true` overrides frontmatter | `src/agents.ts:206-212` |
| `resolveLaunchBehavior()` → `{seededSessionMode, inheritsConversationContext, taskDelivery}` | `src/agents.ts:214-231` |
| `seedSession` in the launch plan | `src/launch.ts:340-347`, `:464-466` |
| Fork → task delivered as a **direct argv arg** (no wrapper instructions) | `src/launch.ts:396-412` |
| `seedSubagentSessionFile()` writes header + copied lines | `src/session.ts:55-75` |
| `getForkContentLines()` — copy parent lines, **truncated at the last user message** | `src/session.ts:29-53` |
| Executor calls seed before `paneStart` | `index.ts:560-562` |
| `PI_SUBAGENT_SESSION` / `PI_SUBAGENT_ID` / `PI_SUBAGENT_NAME` env | `src/launch.ts:427-437`, `:568-572` |

So: **fork exists, it works, and the child gets a real copied transcript with
`header.parentSession` pointing at the parent file.** That is the foundation everything below builds on.
It is also almost entirely undocumented in our own README, untested by our suite, and invisible to our UI.

### 1.2 Companion-side state handling for children

| Extension | Child isolation today |
|---|---|
| `extensions/todo.ts` | `isolateChild = Boolean(process.env.PI_SUBAGENT_SESSION && header?.parentSession)` (`:433`); drops parent-owned/legacy entries (`:439-447`) so a forked child does not inherit the parent's plan |
| `extensions/artifacts.ts` | `isChild` (`:402`); parent catalog published to `<child>.artifacts-parent.json` (`:523-529`, `:538-548`), child writes go to sidecars (`:684-700`), parent ingests them (`:602-612`) |
| `extensions/ask-user.ts` | Child routes to `caller_ping` instead of user UI (`:16`, `:41`, `:78`) |
| `extensions/subagent-checkpoints.ts` | Publishes child milestones via sidecar (`:288-330`); **no child/fork awareness on the read path** |
| `extensions/modes.ts` | **No child awareness at all** (`restore()` at `:100-121` reads `PLAN_MODE_TYPE` from the branch unconditionally) |
| `lib/subagent-state.ts` | `recordsFromBranch()` (`:99-121`) — parent's registry reconstruction; unaware of `parentSession` |
| `lib/vcc-subagent-adapter.ts` | `compileSubagentSession()` / `recallSubagentHistory()` — **parent reading a child**; there is no inverse |

### 1.3 Pi runtime facts that constrain the design

- The active branch, not the file, is the model's context (`SessionManager.buildSessionContext`, `dist/core/session-manager.js:282`).
- A copied transcript replays its **tool loadout**: the leading `system` message declares `toolsAdded`,
  and `_restoreToolsFromTranscript` (`dist/core/agent-session.js:1374-1382`) filters that set through the
  child's `--tools` allowlist. Prompt sections are re-diffed per request (`diffSystemPromptSections`,
  `dist/core/system-prompt.js:140-151`).
- Forked/copied sessions carry `header.parentSession` (`docs/session-format.md:72-77`).
- Pi itself can fork cross-project with `--fork` / `SessionManager.forkFrom()` — a second, unused path for us.
- Entry ids are copied verbatim. New ids are generated against the existing id set, so in-file collisions
  are improbable; **cross-file id identity** (parent and child share entry ids) is guaranteed and matters
  for any id-keyed projection.

---

## 2. Gap analysis — what is missing or wrong

Severity: **P0** = correctness/usable failure, **P1** = needed for the feature to earn its keep,
**P2** = polish/observability.

### G1 — P0: the fork truncation rule silently drops the parent's most recent work

`getForkContentLines()` (`src/session.ts:29-53`) walks backwards to the **last `role: "user"` message**
and copies only lines *before* it. Everything after that user turn — the assistant's analysis, the tool
calls, the tool results, the todo/artifact/mode entries written during that turn — is discarded.

That rule assumes "the parent's last user message is the current request, and the new task replaces it."
Both halves are wrong for us:

- The parent usually delegates **after** doing work ("I've narrowed it to these three files — now have
  the worker fix it"), so the exact lines the child needs are the ones deleted.
- Multi-step parents delegate from *inside* a tool loop, so the trailing user message is several
  assistant turns back; anything after it is silently lost.

Outcome: a "full context fork" that is missing the last 1–n turns, with no signal to the child or parent
that it happened.

### G2 — P0: no provenance marker, so nothing can reason about a fork

The child session's only fork signal is `header.parentSession`, which Pi also sets for `/fork`, `/clone`
and `SessionManager.forkFrom()` — and which Herdr sets for **`lineage-only`** too (`src/session.ts:70`,
`params.mode === "fork" ? … : []`). Consequently:

- `todo.ts` treats *any* `PI_SUBAGENT_SESSION + parentSession` child as a fork (`:433`). A
  `lineage-only` child (empty transcript, genuinely fresh) is isolated identically to a fork child, and a
  `/clone` in a child would too. The heuristic happens to be conservative, but it is not what it claims.
- No code can answer: *was this child seeded fresh, digest-seeded, or full-fork? At which parent leaf?
  How many tokens did it inherit? Was it truncated, and where?*
- `ChildRecord` (`lib/subagent-state.ts:18-33`) has no fork fields, so `/subagents` cannot show mode,
  and the model cannot see that it is talking to a full-context child vs a deaf one.

### G3 — P0: an unguarded fork can exceed the child's context window before it reads the task

The seed copies the parent branch verbatim. The parent may be at 400k tokens of a 1M window on one model
and the child may run on a cheaper 200k model (`agents/*.md` routinely set a different `model:`).
There is no estimate, no cap, no fallback to a digest. First request already fails or auto-compacts
mid-task. Also a real cost regression: a copied prefix only hits provider cache when the child uses the
*same* model **and** the same prompt head — a different model re-reads everything at full price, on every
child, forever.

### G4 — P0: no child-side or parent-side *recall*, only the frozen snapshot

The user-facing goal "subagents should actively recall context from the parent" is unimplemented.
Today a child has exactly one source of parent context: whatever was copied at t=0.

- A **fork** child cannot ask for what changed after the seed, cannot read the parent's newer turns, and
  cannot check "did the parent already fix this?"
- A **standalone / lineage-only** child can never reach parent context at all — by design in the chapter,
  but we already ship `pi-vcc` search over sessions, so the capability is nearly free.
- `vcc_recall` inside a child searches the *child's* session (`pi-vcc/src/tools/recall.ts:42-48`), which
  for a fork is a stale copy of the parent. Our parent-side `recallSubagentHistory()`
  (`lib/vcc-subagent-adapter.ts:130-217`) has no mirror image for children.
- `subagent_history` is registered unconditionally (`extensions/subagent-checkpoints.ts:333`) but its
  registry is rebuilt from the **child's inherited branch**, so inside a fork child it lists the parent's
  *siblings* — children the fork child has no business reading, and no record of its own parent.

### G5 — P1: fork mode silently drops the delegation contract

In fork mode `taskDelivery` is `"direct"` and `fullTask = params.task` (`src/launch.ts:361-366`), so the
child loses: the agent's role block, `modeHint` ("complete autonomously"), and the
`summaryInstruction` ("your FINAL assistant message should summarize…"). Herdr's design assumption is
that the inherited conversation already carries the role/system prompt — true only if the parent ran the
same agent definition, which it does not. Result: fork children that don't summarize (so the parent's
checkpoint summary is thin) and don't know they must exit.

### G6 — P1: inherited policy state is applied without review — Plan mode is the live hazard

`modes.ts:100-121` restores mode purely from the branch. A fork of a Plan-mode parent therefore starts in
**Plan mode**, read-only — arguably correct — but it inherits `previousTools` from the parent's snapshot
(`:86-90`), and `restoreTools()` (`:39-43`) will try to re-activate the parent's tool list in a child
whose allowlist/denylist is narrower. Nothing in `modes.ts` looks at `PI_SUBAGENT_SESSION`,
`parentSession`, or provenance. Same class of problem for `enabledModels`/thinking defaults: inherited
entries replay the parent's model choice into the child's transcript projection.

### G7 — P1: the parent's checkpoint/artifact/todo entries are inherited as *fact*

`recordsFromBranch()` (`lib/subagent-state.ts:99-121`) replays every checkpoint entry on the branch. In a
fork child that includes the parent's whole delegated-work registry, and `checkpointContext()`
(`:160-175`) is injected on **every request** via the `context` hook
(`extensions/subagent-checkpoints.ts:277-286`). So a fork child spends tokens on sibling status it must
not act on, may call `subagent_history`/`subagent_resume` on a sibling, and reports "3 children running"
as if it were the orchestrator. `artifacts.ts` has partial protection (`isChild` paths) but the child's
*read* path merges the parent snapshot with local sidecars and never filters parent-authored artifacts by
child relevance.

### G8 — P1: no depth/breadth control for fork children

`spawning: false` / `PI_DENY_TOOLS` (`src/agents.ts:69-85`) is the only brake. There is no depth counter,
no "children of a fork child may not fork again" rule, and no per-parent cap on inherited-token spend.
Nested forking multiplies both cost and disk.

### G9 — P1: fork copies are invisible in our UI and never collected

`launched()` (`lib/subagent-state.ts:34-58`) records name/agent/task/pane/run — no `mode`, no
`parentLeaf`, no `seededTokens`, no `truncatedAt`. `/subagents` cannot distinguish a fork from a scout, and
nothing ever deletes or compacts the full transcript copies accumulating in the session dir.

**Status after the delegation migration (2026-10).** The spawn path now closes G6 and G8 for ordinary children: `purpose` decides the child's tools (a research child gets no write tool), Plan admits only research/review/spec, a child may not spawn again (`PI_SUBAGENT_DEPTH`), and breadth is capped (`PI_SUBAGENT_MAX_CHILDREN`, default 8). G7 and G9 remain open for **fork** children: inherited checkpoint/artifact entries are still not filtered by relevance, and fork copies still lack `mode`/`parentLeaf` in the registry. Tool names quoted above are the historical v1 surface; the canonical names are `orch_*` (`orch_ping`, `orch_resume`, `orch_progress`, `orch_history`).

### G10 — P2: secrets and scope leak into a new file and a different model

The seed copies the parent's literal transcript, including any pasted credentials, tokens in bash output,
and private paths, into a *new* session file (world-readable directory depending on umask; Pi writes 0600
for headers but copied lines keep the original file's protections only by luck of the copy call), and
feeds it to whatever provider/model the child profile names — possibly a cheaper third-party route.

### G11 — P2: no tests

`tests/*` has no fork/seed coverage. `tests/todo-fork-isolation.test.ts` simulates `parentSession` by hand;
`tests/subagent-runtime.test.ts` mocks a `subagent` tool with no seeding. `getForkContentLines()` and
`seedSubagentSessionFile()` are upstream-tested (`test/launch.test.ts:353-390`) only for "mode plumbing",
never for content correctness.

### G12 — P2: `lineage-only` is a dead concept we still pay for

It seeds an empty transcript with `parentSession` set (`src/session.ts:70`) — i.e. "claims lineage, has no
lineage". It gives us no capability that `standalone` lacks and it poisons the `parentSession` heuristic
in G2. Either give it a real meaning (digest-seeded — see §3) or delete it.

---

## 3. Design: three context shapes + on-demand recall

Blend the chapter's fork variant with our long-lived-child reality. One dial the parent/agent explicitly
sets, one always-available pull channel.

```
mode = fresh      (default)  empty array + self-contained ticket            [chapter 7, today's standalone]
mode = digest     (new)      empty array + VCC-compiled parent brief        [replaces lineage-only]
mode = fork       (exists)   copy of parent branch + ticket                 [chapter 7 fork variant]

+ child tool `parent_recall`  ●pull● parent transcript/branch on demand     [our addition]
+ child tool `parent_digest`  ●pull● VCC algorithmic brief of parent        [our addition]
```

Design rules:

1. **Default stays `fresh`.** Fork is opt-in per spawn or per agent frontmatter — never automatic.
2. **Fork is bounded.** If the parent branch estimate exceeds a budget, fork degrades to `digest` and says
   so, both in the child's first message and in the parent's `ChildRecord`.
3. **Fork carries the ticket.** Role block + completion/summary instructions are always appended, even in
   fork mode (contradicting G5) — they cost ~120 tokens and fix a real failure.
4. **Children can pull.** `parent_recall` works in *every* mode; in `fresh` it is the only parent channel,
   in `fork` it is the freshness channel. This is the piece the chapter does not have and the piece the
   user asked for.
5. **Provenance is first-class data**, recorded on the child session header *and* in the parent's
   `ChildRecord`, and injected as a compact line so both models know the contract.
6. **Inherited policy state is explicit.** Todo and modes get the same isolation treatment, with fork a
   named, tested case rather than an accident of `parentSession` existing.
7. **No new summarizer, no extra inference.** Digests use `pi-vcc`'s zero-LLM compiler, already wired as
   `compileSubagentSession()` — the inverse call is the same call with a different file.

---

## 4. Implementation plan

Ordered. P0 items first; each phase is independently shippable and testable.

### Phase 0 — Provenance contract (G2, G9 foundations)

New `lib/subagent-context.ts` (pure, no I/O) — the single source of truth for the contract:

```ts
export const SUBAGENT_CONTEXT_TYPE = "subagent-context:v1";

export type ContextMode = "fresh" | "digest" | "fork";

export interface ContextProvenance {
  version: 1;
  mode: ContextMode;
  parentSession: string;      // absolute path of the parent session file
  parentLeafId: string | null;// parent branch leaf at seed time
  parentSessionId: string;    // header.id of the parent (not the path)
  seededAt: string;           // ISO
  seededEntries: number;      // parent lines copied (0 for fresh)
  seededChars: number;        // raw bytes copied
  estimatedTokens: number;    // chars/4 heuristic, recorded not enforced
  truncated: { at: string; droppedEntries: number } | null;
  degradedFrom?: "fork";      // set when a fork fell back to digest
  briefSource?: "vcc";        // digest only
}

export function estimateTokens(chars: number): number;
export function provenanceLine(p: ContextProvenance): string; // one compact line for the child's first message + parent record
export function readProvenance(header: unknown): ContextProvenance | undefined;
```

Persist as a `custom` entry immediately after the session header in the seeded file, and as
`header.contextProvenance` (custom header fields are tolerated: `docs/session-format.md:72-77` shows the
header is metadata-only). Prefer the entry — headers are scanned with a byte cap
(`MAX_SESSION_HEADER_SCAN_BYTES`, `dist/core/session-manager.js:306`) and must stay small.

Also extend `ChildRecord` (`lib/subagent-state.ts:18-33`) with:

```ts
mode?: ContextMode; parentSessionId?: string; estimatedTokens?: number; degradedFrom?: "fork";
```

`launched()` reads them from `details.context` when present (Herdr patch below returns them), so
`describe()`/`checkpointContext()` show `🔀 fork (128k inherited)` instead of nothing.

### Phase 1 — Fix the seed rule + budget guard (G1, G3, G10)

Patch `pi-herdr-subagents` (`patches/`); keep it surgical, ~120 lines, table-driven tests.

**1a. Replace the truncation walk.** New rule, in order:

1. Copy the parent's **active branch**, not raw file lines. Use
   `SessionManager.open(parentSessionFile).getBranch()` (already imported in our adapter) so abandoned
   `/tree` branches and post-compaction tails are handled by Pi, not by us.
2. Drop only **the trailing `user` message if and only if it is the branch leaf**. If anything follows it
   (assistant/tool/custom), keep the whole branch — those are the "recent work" G1 loses.
3. Never drop tool results, todo entries, or compaction entries.
4. Record what was dropped in `ContextProvenance.truncated`.

```ts
// src/session.ts
function getForkContentEntries(parentSessionFile: string) {
  const sm = SessionManager.open(parentSessionFile);
  const branch = sm.getBranch();
  const leaf = branch.at(-1);
  const drop = leaf?.type === "message" && leaf.message?.role === "user" ? 1 : 0;
  return { entries: branch.slice(0, branch.length - drop), dropped: drop };
}
```

**1b. Budget guard.** `estimateTokens(seededChars)` against the child's context window
(the child knows its own model only after start, so use the child model resolved in `buildLaunchPlan` →
`effectiveModel` + Pi's model registry; fall back to a configurable
`PI_SUBAGENT_FORK_MAX_TOKENS`, default `0.55 * window`).

- Under budget → seed raw (`fork`).
- Over budget → seed **nothing** and set `mode: "digest"`, `degradedFrom: "fork"`, and write the VCC brief
  to a context artifact referenced with `@` (the existing artifact-backed task-delivery path,
  `src/launch.ts:396-412`). The parent's result `details` carry the degradation so our checkpoint shows it
  and the model can be told its fork was thinned.

**1c. Redaction pass (G10).** Before writing the seed, run a conservative scrub over copied lines for
high-confidence secrets only (`sk-[A-Za-z0-9]{20,}`, `ghp_`, `AKIA…`, `-----BEGIN … PRIVATE KEY-----`,
`Authorization: Bearer …`), replacing the match with `[REDACTED by fork seed]` and recording
`secretsRedacted: n` in provenance. Do **not** attempt semantic scrubbing; this is a seatbelt, not a
policy. Document that fork inherits the rest verbatim.

**1d. Delete or repurpose `lineage-only`** (G12). Repurpose as `digest`: seed empty + provenance entry +
`briefSource: "vcc"`. Keep the frontmatter value accepted for backward compat but map it to `digest`.

### Phase 2 — Always-on ticket in fork mode (G5)

In `resolveLaunchBehavior`, stop conflating "inherits conversation" with "needs no instructions":

```ts
const fullTask = [
  roleBlock,
  modeHint,                                   // always
  launchBehavior.inheritsConversationContext
    ? "The conversation above is your parent's context, copied at launch. It may be stale; use parent_recall to check for newer parent work."
    : "",
  params.task,
  summaryInstruction,                         // always
].filter(Boolean).join("\n\n");
```

Task delivery stays `direct` for fork (an `@` artifact would append a second user message after the
copied branch leaf — harmless but noisier); the longer ticket is still a single argv string.

### Phase 3 — Child-side pull tools (G4) — the headline feature

New `lib/parent-context.ts` + registration in `extensions/subagent-checkpoints.ts` when
`process.env.PI_SUBAGENT_SESSION` is set.

```ts
export interface ParentContext {
  sessionFile: string;      // header.parentSession
  provenance?: ContextProvenance;
  seededEntryIds: Set<string>; // ids already present in the child branch (from fork seed)
}

export function resolveParentContext(ctx: ExtensionContext): ParentContext | undefined;
// header.parentSession must exist AND the file must exist AND be readable.
```

Two tools, both read-only, both degated when no parent:

**`parent_recall`** — VCC search over the parent session, VCC-shaped options so the model already knows
the idiom:

```
parent_recall({ query?, expand?: number[], page?: number, scope?: "lineage"|"all", newerThanSeed?: true })
```

- Reuses `recallSubagentHistory()` (`lib/vcc-subagent-adapter.ts:130`) unchanged — it is already
  file-based and lineage-correct; only the *default scope* and the **filter** change.
- `newerThanSeed` (default `true` for fork children, `false` for fresh/digest) hides entries whose ids are
  in `seededEntryIds`, so a fork child asking "what happened since?" gets a delta instead of a re-read.
- Header note in the output: `Parent: <path> · mode: fork · seed leaf: <id> · showing entries after the seed`.
- Hard cap: same `PAGE_SIZE`-5 pagination and a per-call character cap; never dump a whole transcript.

**`parent_digest`** — `compileSubagentSession(parentSession)` (same function the parent already uses on
children, ~95% reduction, zero inference). Also used by `digest` mode to build its seed brief, so there is
one code path for both.

Registration rules:

- Only when `resolveParentContext()` succeeds — no dead tool in normal sessions.
- `annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }`.
- Add both names to the child allowlist so restricted profiles keep them:
  `SUBAGENT_CONTROL_TOOLS` in `src/launch.ts:125` (the existing `patches/herdr-progress-control.patch`
  pattern) → `"parent_recall", "parent_digest"`.
- Child guidance injected in `before_agent_start` (`extensions/subagent-checkpoints.ts:288`), ~3 lines:
  *"Your parent's session is at <path>. If you need context that is not in your transcript — a decision,
  a file the parent touched, a newer turn — call parent_recall/parent_digest instead of guessing or
  re-reading the whole repo. Never modify the parent session."*

### Phase 4 — Stop leaking the parent's registry into the child (G7)

- `recordsFromBranch(entries, { asOfEntryId? })`: in a child, only records whose launch already exists in
  the child's seed **and** which the child's own `subagent` calls created. Simpler and safer: in a child,
  `checkpointContext()` is suppressed entirely (a child is not an orchestrator), and `subagent_history`
  without an explicit `sessionPath` is refused with a one-line explanation. `/subagents` in a child pane
  should show "this pane is a child (mode: fork, parent: …)" rather than siblings.
- `modes.ts`: gate `restore()` on provenance — for `mode: fork`, restore the *mode* but never the parent's
  `previousTools` snapshot (recompute the child's legal set from its own allowlist); for `fresh`/`digest`,
  behave as today. This also removes the current `parentSession` heuristic accident (G2/G6).
- `todo.ts`: replace `isolateChild` (`:433`) with `provenance?.mode !== "fresh"` (or
  `parentSessionId !== header.id`) so `lineage-only`/digest children are not misclassified.
- `artifacts.ts`: keep the snapshot mechanism, but label entries `from: "parent"` and let
  `artifact_recall` default to "own + parent-relevant" with an explicit `includeParent: true` switch; the
  parent snapshot should carry the parent's `parentLeafId` so staleness is visible.

### Phase 5 — Depth, breadth, collection (G8, G9)

- `PI_SUBAGENT_DEPTH` env exported by the launch script (incrementing `process.env.PI_SUBAGENT_DEPTH ?? 0`),
  and a frontmatter/launch guard: `max-depth` (default 2) denies `subagent` spawns; a fork child with
  `depth >= 1` may not fork again (fresh grandchildren use `digest`, which is cheap).
- `/subagents` rows show `mode` + inherited tokens; detail popup shows provenance and a "parent session"
  open-command.
- Retention: on parent session start, list child sessions with `mode: fork` older than N days and 0
  running records, and offer `/subagents gc` (explicit, never automatic) to delete the copies while
  keeping `.progress-checkpoint.json` summaries. Never auto-delete: transcripts are evidence.

### Phase 6 — Test matrix (G11)

Add to `tests/`, all offline (no inference, no network, matching `tests/subagent-runtime.test.ts` style):

`tests/context-provenance.test.ts`
- provenance round-trips through a header entry; malformed/absent → `undefined`; `estimateTokens` bounds.

`tests/fork-seed.test.ts` (pure, imports upstream `src/session.ts` via a fixture copy in `patches/`)
- leaf is a user message → dropped, `truncated.droppedEntries: 1`.
- leaf is an assistant/toolResult (the G1 case) → **nothing dropped**, assistant + toolResult present.
- abandoned `/tree` branch in the parent file → only the active lineage is copied.
- compaction entry survives; `firstKeptEntryId` still resolves in the child.
- budget overrun → `digest` + `degradedFrom: "fork"` + brief artifact referenced.
- secret-shaped strings → redacted, count recorded; non-secret content byte-identical.
- copied ids are unchanged; header id is new; `parentSession` points at the source.

`tests/parent-context.test.ts`
- `parent_recall` unavailable in a normal session; available in a child whose parent file exists.
- `newerThanSeed` hides seeded ids and returns only the delta; pagination caps honored.
- `parent_digest` output equals `compileSubagentSession(parent)` for the same file.
- parent file missing → single clear error, no partial output, no writes.

`tests/fork-isolation.test.ts`
- fork child: todo starts empty (already covered) **and** modes does not restore parent `previousTools`.
- fork child: `checkpointContext` suppressed; sibling records invisible.
- `fresh`/`digest` child: todo isolation still correct under the new provenance signal.

Runtime (`tests/subagent-runtime.test.ts` additions)
- scripted provider child process run: seed a parent session file, launch with `fork: true` (fixture
  tool), assert the child's first captured request contains the parent's assistant text **and** the
  ticket instructions **and** the provenance line; assert `parent_recall` is registered and its result
  reaches the provider.

Gates: `npm test`, `npm run typecheck`, plus a forward/reverse `patch --dry-run` for the Herdr patch
(same discipline as `patches/VERIFICATION.md`).

---

## 5. Explicit non-goals

- **Fork by default.** It re-reads the parent context on every child; the chapter's whole point is that
  fresh children save working memory. Default stays `fresh`.
- **Recursive fork hierarchies.** Depth cap is a feature, not a limitation.
- **Live parent context.** `parent_recall` reads the parent session file as-is. If the parent is mid-turn,
  the child sees a partial branch — acceptable, documented, and strictly better than a frozen seed.
  No IPC, no sockets, no new transport.
- **Semantic secret scrubbing / DLP.** Pattern redaction only (Phase 1c).
- **Changing Pi.** All of this rides on `SessionManager`, `appendEntry`, custom session entries, and env
  vars already in use. No core patches.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Copying ids verbatim breaks an id-keyed projection we add later | Provenance records `parentSessionId`; any cross-session projection keys on `(sessionId, entryId)` |
| `SessionManager.open()` on a *running* parent could initialize/rewrite a file | Read-only: `parseSessionEntries(readFileSync(...))` + `SessionManager.inMemory(...)` exactly as `transcriptPreview()` (`extensions/subagent-checkpoints.ts:46-70`) already does |
| Herdr patch drift on upgrade | Keep it in `patches/`, reapply by `--dry-run`, documented in README §Activation/rollback (existing pattern) |
| Budget estimate wrong for image/tool-heavy branches | Chars/4 heuristic + safety factor 0.55 of window + degrade-not-fail; log estimate in provenance for calibration |
| Fork child acts on stale sibling/registry data | Phase 4 suppresses child-side registry injection entirely |
| User surprise at cost of a fork | `/subagents` shows inherited tokens; `/iterate` warns once per session when parent branch > 60k tokens |

## 7. Rollout

1. Phase 0+1 (provenance + seed fix + guard) — invisible, no behavior change without `fork: true`.
2. Phase 2+3 (ticket + `parent_recall`/`parent_digest`) — the user-visible win; children gain pull.
3. Phase 4 (isolation) — closes the leaks; update README §3 with a "Context modes" subsection and the
   three-mode table from §3.
4. Phase 5+6 (observability, GC, tests) — harden.

Each phase: restart Pi (or `/reload`) **after running children finish** — never reload mid-child
(`README.md` §3 "Registry recovery is not process recovery").

## 8. Open questions

1. Should `/iterate` become `/fork-agent`, with explicit `--digest` / `--fresh` flags? Current `/iterate`
   forces `fork: true` with a vague task — the one place a fork is spawned without a real ticket.
2. Do we want `fork: "digest"` as a tool param value instead of a separate `contextMode` param?
   (`fork: boolean` exists and is documented; adding `context-mode` alongside risks two sources of truth.)
3. Should the provenance line be injected as a `custom` message (`display: false`) on the child's first
   turn, or stay in the argv ticket? Argv is cheaper and survives compaction; a custom entry is visible in
   the child's transcript. Lean argv + one `subagent-context:v1` entry for machines.
4. Do we expose `parent_recall` to the **parent** as `child_recall` alias, or keep `subagent_history` only?
   (Probably keep both names distinct; different files, different trust.)
