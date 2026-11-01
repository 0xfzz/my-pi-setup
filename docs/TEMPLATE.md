# <Part of the surface>: <short name>

> Part of [pi-workflow-extensions](../README.md). <One sentence: what this note
> answers.>

| | |
| --- | --- |
| **Status** | one of: current operator guide · current policy · design note · audit · historical record |
| **Detail for** | [README § <section>](../README.md) |
| **Scope** | the paths this note is about, e.g. `lib/vcc/`, `extensions/todo.ts` |
| **Verified against** | the suites that pin the behaviour, e.g. `tests/todo-v2.test.ts` |
| **Related** | sibling notes this one depends on or is often read with |

Then five bullets, at most one line each — the whole note compressed. A reader who
stops here must not be misled; everything after the bullets is the detail.

- **What it is** — the one-line identity of the thing this note describes.
- **Why it exists** — the failure mode or need it addresses.
- **How it is enforced** — where the rule lives in code, not just that it is a rule.
- **What it refuses** — the boundary; what is deliberately *not* allowed.
- **What it cannot do** — the honest limit, including anything trusted rather
  than sandboxed.

---

## Detail

The rest of the note: mechanics, the decision table, the failure modes, the
commands, and the edge cases. Use `##` sections here, one idea per section.

Prefer a table over prose when the content is a set of rules, and a short code
block over a description when the content is a command.

## Tests

Name the suites that cover this note, and say plainly what they do **not** cover.
A note whose behaviour is unpinned should say so here rather than imply coverage.

## Removal

How to turn this part off without damaging unrelated data, and what happens to
the files it leaves behind.

---

## Conventions for every note

- **One note per part of the surface.** README summarises in one table row; the
  note holds the detail. Do not duplicate a paragraph between the two — link.
- **The header block is required.** Status, scope and verification are what let a
  reader tell a current guide from a historical audit.
- **State the boundary.** Every note that constrains the agent should say what it
  does *not* protect against, in the same breath as what it does.
- **Verification is a claim, not a vibe.** Name real suites; if the note was not
  re-verified, say that instead of implying it was.
- **Do not edit `docs/patches/`.** That directory is an applied-diff record, not
  documentation.
