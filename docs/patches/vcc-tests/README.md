# VCC projected compaction + recall fix (Pi 1.3.0 / pi-vcc 0.4.1)

| Field | Value |
| --- | --- |
| **Status** | install + test record |
| **Detail for** | [README](../../../README.md) |
| **Scope** | installed `pi-vcc` 0.4.1 sources |
| **Verified against** | `node --test docs/patches/vcc-tests/regression.mjs` |
| **Related** | [Verification](../VERIFICATION.md) |

## Summary

- The zero-LLM compiler is preserved: no provider call was added, transcripts are not rewritten.
- Only three installed files change; each change and its reason is listed.
- The regression harness exercises those changes against real Pi projection APIs.
- Retention/index behaviour, rollback and limitations are specified.

## Preserved concept

VCC remains a **zero-LLM, algorithmic conversation compiler**. Its normalizer,
noise filter, extraction, structured section/brief generation, previous-VCC-summary
merging, and configuration are unchanged. No provider or network call was added.
Raw transcripts are not rewritten. No session was reloaded.

## Exact installed changes

Only these three installed files changed under `/home/faiz/.pi/agent/npm/node_modules/pi-vcc`:

- `src/hooks/before-compact.ts`: removes the raw-message-only `buildOwnCut` and its
  empty-ID compact-all sentinel. Uses the supplied Pi preparation's
  `messagesToSummarize` **plus** `turnPrefixMessages`, its exact `firstKeptEntryId`,
  `tokensBefore`, previous summary, and file operations. Custom and branch-summary
  messages go through Pi's `convertToLlm` before the unchanged VCC compiler. Thus
  projection omissions/replacements and repeated-compaction boundaries are honored.
  Kept statistics use the projected tail and Pi token estimator. Success/failure
  lifecycle tracking uses the stable session manager rather than different event
  objects. Removed the obsolete compact-all-only 4096-token guard; an empty summary
  cancels without falling through to an LLM. Default opt-out remains unchanged.
- `src/core/load-messages.ts`: loads `custom_message` (including `display:false`)
  and `branch_summary`, in addition to ordinary messages. Converts extension/summary
  content using Pi's entry/message adapters for search and expansion; renders custom
  entries as `custom` with `[customType]`, branch summaries as `branch_summary`.
  Excludes plain `custom` extension-state records. Indices are allocated before
  lineage filtering; raw message/ID/rendered arrays stay aligned. Recall intentionally
  reads historical content even if context-edited or compacted away.

- `src/core/lineage.ts`: treats an empty active `getBranch()` result as an
  authoritative empty allowlist instead of falling back to all raw entries. This
  prevents abandoned history from leaking into default lineage recall after
  `resetLeaf()`. Existing exception fallback behavior is unchanged; this is the
  requested empty-branch boundary fix only.

## Artifacts

- Original files: `../vcc-backup/src/hooks/before-compact.ts`,
  `../vcc-backup/src/core/load-messages.ts`, and `../vcc-backup/src/core/lineage.ts`.
- Unified patch: `../vcc-projected-compaction-recall.patch` (paths relative to package).
- Offline tests: `regression.mjs`.

Apply to an **unmodified pi-vcc 0.4.1** installation:

```sh
patch --dry-run -p1 -d /home/faiz/.pi/agent/npm/node_modules/pi-vcc < /home/faiz/projects/pi-workflow-extensions/patches/vcc-projected-compaction-recall.patch
patch -p1 -d /home/faiz/.pi/agent/npm/node_modules/pi-vcc < /home/faiz/projects/pi-workflow-extensions/patches/vcc-projected-compaction-recall.patch
```

Already applied here. Both forward dry-run against the backup and reverse dry-run
against installed files passed. Rollback: use `patch -R -p1` against the installed
package with the same patch, or restore the three backed-up files.

## Verification

```sh
node --test /home/faiz/projects/pi-workflow-extensions/patches/vcc-tests/regression.mjs
```

**10 tests passed** using Node's test runner, installed jiti, and the real installed
Pi 1.3.0 projection/preparation APIs. The lineage regression uses a real
`SessionManager.inMemory()` instance and `resetLeaf()`; no persisted live session,
API, session reload, or credentials are required. Tests cover:

1. Both prepared message lists, deterministic VCC output, custom/branch inclusion,
   exact retained boundary/token count, and rebuilt context.
2. Context-edit replacement of custom content and omission of an assistant response.
3. Assistant call + parallel tool-result boundary preservation.
4. Repeated compaction and prior VCC summary merging.
5. Newly appended custom result retained verbatim.
6. Custom-started history with no ordinary user entry.
7. Legacy empty/missing and modern retain-none prior boundaries.
8. Recall hidden/array custom messages, branch summaries, state exclusion, search,
   full expansion, scoped index stability, raw-history semantics, malformed JSONL.
9. Real in-memory SessionManager: `resetLeaf()` yields no default-lineage results
   despite retained abandoned history; all scope still works, and a new root only
   exposes its own entries while preserving raw-history index gaps.
10. Opt-out and failed-compaction stats cleanup.

The malformed JSONL warnings are intentional. Fixture files are created only under
this directory and removed afterward. `PI_RUNTIME_ROOT` and `VCC_ROOT` can override
installation paths. jiti aliases map the old `@mariozechner/*` package names to the
installed `@earendil-works/*` runtime; filesystem compilation cache is disabled.
The test context provides no model registry, so accidental summary API calls fail.

Existing package checks were attempted before editing:

- `npm test`: cannot run (`vitest: not found`). No test files ship in this install.
- `npm run typecheck`: cannot run (`tsc: not found`); no tsconfig ships here either.

No packages/dependencies were installed to work around these limitations.

## Behavioral changes and limitations

- Retention now follows Pi's resolved `keepRecentTokens` and legal split-turn
  boundary rather than VCC's former last-raw-user / compact-everything policy.
  This can retain more context and change compression ratios. Summary generation
  is still entirely VCC, not Pi's LLM summarizer. Pi may decline to prepare tiny
  histories or immediately repeated compactions; VCC does not invent a cut.
- New custom/branch entries participate in recall numbering. Indices are stable
  across scope/query/full views for the same transcript, but **old pre-patch numeric
  indices after newly included entries will shift**. Refresh searches before expand.
- Existing deterministic summary clipping/noise rules and previous-summary-format
  assumptions remain unchanged: this fixes entry selection, not lossless summaries.
  Full text remains available through recall. Image payloads are not text-searchable.
  Recall continues not to index compaction-summary entries themselves.
- Targets installed Pi 1.3.0 APIs; older upstream versions are not certified.
  No live TUI/provider or full static typecheck was performed. Existing loaded
  sessions keep their currently loaded extension code; no reload was performed.
- A package reinstall/update can overwrite installed edits. Reapply only after
  checking patch compatibility and rerun these tests.
