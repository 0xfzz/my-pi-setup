---
name: maintain-clean-code
description: "Use whenever you add, change, fix, review or refactor code in pi-workflow-extensions (extensions/, lib/, tests/, scripts/). Enforces small, pure, testable functions, Clean Code principles, and the Refactoring.Guru smell-to-refactoring catalog, plus this repo's test, lint and commit gates. Use it before writing a new function, when a file or function feels too big, when fixing a bug, or when asked to clean up, refactor or review code."
---

# Maintaining this codebase cleanly

Every change leaves the code easier to read and easier to test than you found it.
This skill is the checklist. Follow it for new code, bug fixes, and refactors.

Reference for smells and refactorings: [`references/refactoring-catalog.md`](references/refactoring-catalog.md)
(a map of [refactoring.guru](https://refactoring.guru/refactoring/smells) smells to the
refactorings that fix them). Read it when you spot a smell and need the named fix.

## 1. Before you write anything

1. Read the surrounding code and match its naming, comment density and idiom.
2. Find where the logic belongs (see [Where code goes](#where-code-goes)).
3. Decide how you will test it **first**. If you cannot describe the test in one
   sentence, the function is doing too much. Split it before you write it.
4. Fixing a bug? Write the regression test first and watch it fail. Name the failure
   mode in the test title (`CONTRIBUTING.md` requires this).

## 2. Where code goes

| Kind of code | Location | Rule |
|---|---|---|
| Decisions, parsing, formatting, policy, state transitions | `lib/*.ts` | Pure functions: input in, value out. No Pi API, no I/O, no clock, no env. |
| Pi wiring: `registerTool`, `registerCommand`, event hooks | `extensions/*.ts` | Thin adapter. Reads inputs, calls `lib/`, returns the result. Only files listed in `package.json` → `pi.extensions` live here. |
| Tests | `tests/*.test.ts` | `node:test` + `node:assert/strict`, imports use `.ts` extensions. |

The pattern to copy is `lib/spawn-policy.ts` plus `tests/spawn-policy.test.ts`: a pure
decision function in `lib/`, tested directly with no Pi session, network or credentials.

When a function in `extensions/` contains a decision, extract the decision to `lib/`
and leave the side effect behind. That is the main way to make this code testable.

## 3. Function rules (Clean Code)

- **Do one thing.** If you need "and" to describe it, split it. Aim for under ~20 lines
  and one level of abstraction per function.
- **Name it for what it returns or decides**: `spawnRefusal`, `allowedSpawnPurposes`.
  Predicates read as questions (`isSubagentChildSession`). Never `handle`, `process`,
  `doStuff`, `data`, `info`, `manager`.
- **At most 3 parameters.** More than that is a missing type: pass an options object
  or a named interface (Introduce Parameter Object).
- **No boolean flag parameters.** `f(x, true)` is unreadable and means two functions.
  Split them, or use a named options field.
- **Separate commands from queries.** A function either changes state or returns an
  answer, not both.
- **Avoid hidden inputs.** Do not read `process.env`, `Date.now()`, `Math.random()` or
  module-level mutable state inside logic. Pass them in so a test can control them.
- **Return early** with guard clauses instead of nesting. Keep nesting at 2 or less.
- **Replace magic numbers and strings** with named constants (`MAX_DELEGATION_DEPTH`).
- **Prefer a discriminated union or result value over throwing** for expected outcomes
  (`string | undefined` refusal, as in `spawnRefusal`). Throw only for programmer error
  or truly exceptional I/O failure.
- **No dead code, no commented-out code.** Git remembers it. `npm run lint:dead` (knip)
  fails on unused exports, so do not export what nothing imports.
- **Comments explain why, never what.** If a comment narrates the code, rename or
  extract until the code says it. Keep the existing long "why" headers where they carry
  an invariant or a past failure mode.
- **Do not suppress types** with `any` or `as unknown as X` to get past a problem.
  Narrow the type or fix the model.

## 4. Testability rules

- Test **behaviour through the public function**, not private helpers.
- One reason to fail per test. Title states the behaviour or the failure mode.
- Cover the boundaries: empty, one, many, undefined, unknown enum value, error path.
- No network, credentials, inference or live Pi session in unit tests. Use the in-process
  scripted provider pattern already in the delegation tests when a session is unavoidable.
- No sleeps or real timers. Inject the clock or the scheduler.
- Use temp directories (`mkdtemp` under `tmpdir()`), clean up in `finally`, and never
  absolute paths from your machine.
- Integration-tier tests go in `tests/tiers.json` (see `scripts/test.mjs`).
- Run one file while iterating: `node --experimental-strip-types --test tests/<name>.test.ts`.

## 5. Refactoring discipline (Refactoring.Guru)

Refactoring changes structure and **never behaviour**. Treat that as a hard line.

1. **Green first.** Run the relevant tests. If the code has none, write characterization
   tests that pin current behaviour before you touch it.
2. **Name the smell**, then pick the named refactoring from the catalog. Say which one
   in the commit body (for example "Extract Method" or "Replace Conditional with
   Polymorphism"). Do not improvise a rewrite.
3. **Small steps**, tests green after each. Revert a step rather than debugging a big one.
4. **Never mix refactoring with a behaviour change** in one commit. Refactor commit first
   (`refactor(area): ...`), then the feature or fix on top. A mixed commit cannot be
   reverted cleanly.
5. **Rule of three.** Tolerate duplication twice, extract on the third copy. Do not
   build abstractions for a single use.
6. **Boy-scout, not crusade.** Clean the code you are already touching. Do not mass
   refactor a large file (`extensions/agent.ts` is 4k+ lines) as a side effect of an
   unrelated task. If the cleanup is big, make it its own commit, or raise it with the
   user.

Quick smell triage (full table in the reference):

| You see | Smell | First refactoring |
|---|---|---|
| Function over ~20 lines or doing several things | Long Method | Extract Method |
| File or object that knows everything | Large Class | Extract Class / Extract Module |
| 4+ parameters | Long Parameter List | Introduce Parameter Object |
| Same `if/switch` on a type in several places | Switch Statements | Replace Conditional with Polymorphism / lookup table |
| Same block in two places | Duplicate Code | Extract Method, Pull Up |
| Function using another module's data more than its own | Feature Envy | Move Method |
| Chains like `a.b.c.d` | Message Chains | Hide Delegate |
| One change forces edits in many files | Shotgun Surgery | Move Method / Inline Class |
| Unused param, variable, export, branch | Dead Code | Delete it |
| Comment explaining a confusing block | Comments smell | Extract Method / Rename |
| Primitive strings and numbers standing in for concepts | Primitive Obsession | Replace Data Value with Object / union type |

## 6. Definition of done

Run from the repo root:

```sh
npm run tidy    # typecheck + lint:smell + test + test:web
```

If you added, moved or removed exports or files, also run `npm run lint:dead`.

- The only accepted baseline failures are the two `native regular/fullscreen inline
  custom UI reproduces clipping…` tests. Anything else is yours to fix.
- Fix `oxlint` warnings at the cause. Never rename a binding to `_`, delete behaviour,
  or turn a rule off to get green. A real false positive gets the narrowest per-line
  suppression with a comment saying why.
- If you changed behaviour or a tool surface, update `README.md` or the matching note in
  `docs/` (they follow `docs/TEMPLATE.md`).
- Commit each coherent unit with a scoped conventional message (`feat(area):`,
  `fix(area):`, `refactor(area):`, `test:`, `docs:`). End with a clean `git status`.
  Never force-push or rewrite shared history.

## 7. Self-review before you hand off

Answer each honestly. A "no" means keep working.

- Can every new function be tested without Pi, network, disk or a clock?
- Does each function have one reason to change and a name that says what it does?
- Did I remove duplication I introduced, and leave no dead code or unused export?
- Does a test fail if I break the behaviour I just wrote?
- Is the diff one work unit, with refactoring separated from behaviour changes?
- Would a reviewer understand the change from the code and commit message alone?
