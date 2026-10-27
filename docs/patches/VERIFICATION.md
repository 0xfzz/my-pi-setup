# Delegated-work implementation verification

Verified on the installed Pi 1.3.0 / Node 22 setup.

- `npm test`: **38/38 passed** (`workflow-test-results.tap`).
- `npm run typecheck`: passed for the workflow package (`workflow-typecheck-results.txt`).
- `node --test patches/vcc-tests/regression.mjs`: **10/10 passed** (`vcc-tests/results.tap`).
- Herdr compatibility patch: forward dry-run against backed-up launch.ts and reverse dry-run against installed launch.ts passed.
- VCC patch: reverse dry-run against all three installed source files passed. The VCC implementation agent additionally verified the forward dry-run against backups.
- Independent review initially found five correctness issues; all were addressed. Follow-up review found no remaining concrete blocker. Concurrent notification replay was checked by inspection; no dedicated overlapping-I/O test was added.
- Real Pi runtime integration uses an offline scripted provider. It verifies actual request context, native compaction, session persistence and reload. Native dashboard dialogs are mocked, not interactively TUI-tested. No live inference, network, credentials, child-process launch or main-session reload was used for verification.
- VCC's shipped vitest/full static checks remain unavailable in that installed package. Its focused regressions exercise the installed source with real Pi projection/preparation APIs, retaining the zero-LLM compiler.

Activation: after all running children finish, restart Pi or `/reload`, then use `/subagents`. New children inherit the milestone tool. Reload restores the registry, not Herdr's in-memory completion monitors: unfinished records are deliberately unverified, never automatically restarted. Existing active children should finish before activation.

See `../README.md` and `vcc-tests/README.md` for implementation details, patch reapplication, behavior changes and rollback.
