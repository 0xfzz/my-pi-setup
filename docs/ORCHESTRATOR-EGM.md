# Orchestrator: review shell and EGM subset

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

Regression tests accompany each fix (rather than committing a deliberately red
suite). Each coherent unit is verified and committed before the next.

## Audit targets

- Reject partial reviewer policy instead of treating it as an ordinary worker.
- Refuse generic reviewer resume/author-answer routes before side effects; fresh
  isolated review attempts are the recovery path.
- Block readiness on blocked/incomplete reports and unresolved missing context.
- Require ready matching spec reviews for Orchestrator implementation admission,
  including resume; Normal delegation is unchanged.
- Inspect real reviewer context and filesystem search boundaries.

Review-ready is not human execution approval. Ordinary user authorization to
implement is still required; a model-authored boolean is not proof of consent.
