# Worker names: provenance

The dashboard gives every worker a human given name from a **vendored, offline**
list of Javanese male given names.

- **Source:** <https://en.wiktionary.org/wiki/Category:Indonesian_male_given_names_from_Javanese>
- **Snapshot:** 2026-10-26 (two category pages)
- **Entries:** 278
- **License:** CC BY-SA 4.0 (Wiktionary)
- **Vendored file:** [`src/names.javanese.mjs`](src/names.javanese.mjs) (`JAVANESE_GIVEN_NAMES`, `NAMES_SOURCE`)

## What was copied

**Only the names.** No definitions, no etymology, no page prose and no other
Wiktionary content are included in this repository. The names are factual data
(a list of personal names); the CC BY-SA 4.0 attribution above keeps the source
honest, and no licensed prose is redistributed.

## How it is used

`src/naming.mjs` hashes a stable entity id (FNV-1a) into the list, probes forward
past names already claimed in the same session, and composes
`<GivenName> · <Role>` for display (`Bima · Skeleton Builder`). The mapping is a
pure function of the id, so a worker keeps its name across reloads, restarts,
resumes and status updates.

Explicit names chosen by the author of a spawn are never overwritten. The
orchestrator itself is not a dictionary name: it reads as `{Project} Manager`.

## Maintenance

The list is frozen (`Object.freeze`) and asserted in `tests/dashboard-naming.test.ts`
(exactly 278, unique, ASCII, sorted, immutable). Do not edit names by hand to
"fix" a label — change the role composition or the explicit-name rule instead.
Refreshing the snapshot means re-copying the category names, updating
`NAMES_SOURCE.retrieved`/`count`, and re-running that test.
