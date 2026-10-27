# Orchestrator: review shell and EGM subset

| Field | Value |
| --- | --- |
| **Status** | current reference |
| **Detail for** | [README § Orchestrator mode](../README.md) |
| **Scope** | `extensions/orchestrator.ts`, `lib/orchestrator/`, `lib/spawn-policy.ts` |
| **Verified against** | commit `9a6cf72` baseline stated below; re-read at `f155a18` |
| **Related** | [Baseline](BASELINE.md) · [Dashboard](ORCHESTRATOR-DASHBOARD.md) |

## Summary

- Three roles, not three prompts: Elephant (context-rich parent), Goldfish (independent spec reviewer), worker (one handoff, one lane).
- Review-ready, human-approved and implemented are three different facts; a cancelled dialog is never consent.
- A verdict binds to a content hash, a fix forces a fresh review, and a stale approval is refused at both ends.
- The EGM subset is pinned, reviewed, direct-dispatch, findings — not the upstream scheduler, UI or bootstrap machinery.

## Execution baseline

Before this change (commit `9a6cf72`), working tree clean:

- `npm run typecheck`: exit 0.
- `npm test`: 1001 passed, 1 skipped, 2 failed. Only the documented
  `native regular/fullscreen inline custom UI reproduces clipping…` failures.
- Pi runtime: installed release 1.4.0; extensions use jiti and `tool_call`
  in-place input mutation. Tests must include the real loader, not just TS imports.
- EGM upstream `main` inspected at `d0a2e744d8df68c8cb042b98beca32f5df3c95f4`:
  https://github.com/google/elephant-goldfish-model

## Scope

Implement the spec-driven Elephant/Goldfish core, not the whole upstream plugin.
The parent is the context-rich Elephant; independent specification reviewers are
Goldfish; implementation workers are neither role by default.

The user requested a lightweight reviewer shell. Orchestrator/Supervise parents
will use **trusted scripts with prompt-enforced review intent**, not an OS
sandbox. Bash/Python/Node can write files; hidden write/edit tools do not change
that. Plan retains its conservative shell grammar. Goldfish get no shell.

### Shell trust boundary

- Orchestrator/Supervise parent: arbitrary bash/python/node for inspection,
  parsing and verification. Direct write/edit/patch tools remain unavailable.
- Plan: the existing read-only command grammar (`lib/plan-shell.ts`).
- Goldfish reviewer: no bash at all (denied by policy and the launch allowlist).
- The Orchestrator shell is **not sandboxed**. A script can write. The prompt
  forbids repair, formatting, installs, commits/resets and control-plane writes,
  and changes must be delegated to a worker. Evidence gathered only through the
  shell is attested, not authenticated; `orch_check` receipts are the stronger
  form. Never label this shell "read-only enforced".

Regression tests accompany each fix (rather than committing a deliberately red
suite). Each coherent unit is verified and committed before the next.

## Role contract

| Role | Context | May change | Purpose |
| --- | --- | --- | --- |
| Elephant (Orchestrator parent) | full session, artifacts, repository | specs and control plane; no product code in Supervise | decompose, delegate, verify |
| Goldfish (spec reviewer) | pinned snapshot plus named permitted paths | its report only | independent judgement |
| Worker | exactly one handoff/ticket | its lane | implement and verify |

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

Reviewer context is the ticket's pinned text and explicitly named references.
Reviewers get `read`, named-path search, todo tools, and the submit tool. A
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

Review-ready is not human execution approval. Ordinary user authorization to
implement is still required; a model-authored boolean is not proof of consent.
