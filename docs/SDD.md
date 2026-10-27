# Spec-Driven Development in the orchestrator

The orchestrator has one permission mode and two workflows:

```text
/mode orchestrator        # one capability: delegate and review, never implement
/orch-mode sdd            # durable specs, tasks and a review gate (default)
/orch-mode general        # handoff delegation without SDD artifacts
```

`regular` is accepted as an alias for `general`. Leaving Orchestrator keeps the
choice; re-entering restores it. `/orch-mode` with no argument reports the active
workflow.

## What SDD means here

SDD is the same loop in both workflows:

```text
intent → specification → review → task slice → worker → evidence → convergence
```

In **SDD**, the intent and task breakdown are durable Markdown files under
`specs/`. In **General**, the handoff is the only spec and `designRef` is
optional. General still requires a handoff because the review needs criteria and
a lane; it is not ad-hoc implementation.

## Artifacts

`orch_sdd` writes only under `<repo>/specs/`, where the repo root is the
session's working directory:

```text
specs/
  <feature>/
    spec.md
    plan.md
    tasks.md
  <epic>/
    roadmap.md                 # optional; plain Markdown
    <slice>/spec.md
    <slice>/plan.md
    <slice>/tasks.md
```

The three files are create-only. A changed contract creates
`<feature>-v2` instead of rewriting a reviewed file. This is the project's
**flow-forward** persistence convention.

### spec.md

Required sections: Problem, Goals, Non-goals, Requirements (`FR-###`), Acceptance
scenarios (`AC-###`), Constraints and assumptions, Clarifications, Open questions,
Out of scope. `orch_sdd specify` fills the template and assigns ids.

### plan.md

Required sections: Approach, Affected files/interfaces, Test strategy, Risks, Task
mapping.

### tasks.md

```md
- [ ] T001 [P] Add retry interface
  Depends: T000
  Maps: FR-001, AC-001
  Files: src/net/retry.ts, src/net/retry.test.ts
  Verify: npm test -- retry
```

`[P]` tasks may run in parallel only when their `Files` lists do not overlap.

## Actions

| Action | Writes | Meaning |
| --- | --- | --- |
| `specify` | `spec.md` | Create the feature contract; auto-assigns FR/AC ids. |
| `clarify` | `spec.md` | Append a Q/A and close one open question; before `plan`. |
| `plan` | `plan.md` | Create the implementation plan; refuses unresolved questions. |
| `tasks` | `tasks.md` | Create the task breakdown; requires a plan. |
| `analyze` | none | Five consistency checks. |
| `status` | none | Files, spec status, ready tasks, `[P]` groups, review state. |

`status` and `analyze` are read-only and are the only actions available in Plan
mode. Mutating actions require leaving Plan.

### analyze

- `SDD-SECTION` — missing required section or file
- `SDD-ID` — duplicate or unknown `FR/AC/T` reference
- `SDD-MAP` — requirement without a task, or task without a mapping
- `SDD-DEP` — unknown or cyclic task dependency
- `SDD-LANE` — parallel tasks with overlapping files

`analyze` never edits.

## Review and implementation

1. Review the spec before planning or implementation:

   ```text
   orch_spec_review({ action: "start", targetFile: "specs/retry-policy/spec.md" })
   ```

2. Once ready, the review's `runId` and `targetHash` become the handoff's
   `designRef`. In SDD, implementation refuses a handoff without a ready,
   unchanged review. In General, `designRef` is optional.

3. Turn selected tasks into a frozen handoff:

   ```text
   orch_handoff({
     scope: "retry-t001",
     sdd: { featureDir: "specs/retry-policy", taskIds: ["T001"] },
     designRef: { runId, targetHash }
   })
   ```

   `goal`, `acceptanceCriteria`, `laneFiles`, and `verifyCommand` are derived from
   the selected tasks (a supplied lane must match). The child receives only that
   task slice in its artifact.

4. Spawn the worker and review the implementation with `orch_review`.

`orch_spawn` re-reads `tasks.md` and refuses if a task became done, was edited, or
is no longer dependency-ready. A refused spawn creates no pane.

## Convergence

After an approved `orch_review`:

- mark completed tasks `[X]` in `tasks.md`;
- append remaining work as fresh `T###` entries with `Source: converge`;
- do not edit `spec.md` or `plan.md`;
- run `orch_sdd analyze` again.

Convergence is append-only. A new requirement that changes intended behavior
creates `<feature>-v2`; it does not rewrite the old contract.

## Roadmap / spec of specs

For an epic too large for one cycle, keep a plain
`specs/<epic>/roadmap.md` table:

```md
| ID | Sub-feature | Intent | Scope boundary | Depends on | Status | Sub-spec |
|----|-------------|--------|----------------|------------|--------|----------|
| R1 | Retry core  | ...    | in / deferred  | —          | done   | specs/retry-core/ |
| R2 | Retry UI    | ...    | in / deferred  | R1         | planned| — |
```

The sub-spec starts with:

```md
**Input**: Parent roadmap: `specs/retry/roadmap.md` → entry **R2**.
```

The roadmap is a convention, not a tool. Spec Kit itself treats a plain Markdown
roadmap as sufficient; no special metadata engine is required.

## Complex features

- **Limit a run:** select a bounded task set with `status` / task ids.
- **Delegation:** one `orch_handoff` per `[P]` group or dependency-ready slice.
- **Combine:** select a phase, hand off each non-overlapping group.
- **Decompose:** create a roadmap and run the full SDD cycle per slice.

## Boundaries

- `orch_sdd` is available only in SDD; General hides and refuses it.
- Plan mode allows only `status`/`analyze`.
- The orchestrator never edits product code; workers implement task slices.
- The orchestrator never commits. Specs are committed by the normal workflow.
- There is no `orch_sdd init`, constitution engine, roadmap parser, or converge
  action; those are documented conventions, not code.
