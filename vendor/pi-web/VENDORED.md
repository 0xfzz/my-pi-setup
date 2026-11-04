# Vendored: pi-web

Fork base for the workflow web dashboard, per
[`docs/prds/fork-pi-web-integration.md`](../../docs/prds/fork-pi-web-integration.md).

| Field | Value |
| --- | --- |
| **Upstream** | [agegr/pi-web](https://github.com/agegr/pi-web) @ `f130910` (v0.15.0, MIT) |
| **Vendored at** | source tree only: no `.git`, no `node_modules/`, no `.next/`, no `test-results/` |
| **License** | MIT (upstream `LICENSE` kept in place) |
| **Builds** | never committed: `vendor/pi-web/node_modules`, `vendor/pi-web/.next` stay out of git |
| **Smell gate** | this tree is upstream verbatim, so `lint-staged` ignores `vendor/pi-web/**` and `npm run lint:smell` does not scan it; upstream warnings are upstream's, and editing them away would break resync. New fork files written by us ARE held to the gate when touched in a commit that also touches our files — the ignore is per-path, not per-rule |

## Fork diff policy

The tree above is upstream verbatim. The fork diff (plugin host, sidebar section,
`/plugins/[id]` page, one e2e check) is added in commits after this one and must
stay limited to what the PRD's R9 allows. Keep every fork file listed here:

- `VENDORED.md` — this file (the only new top-level file)

## Resyncing a newer upstream

1. `git clone --depth 1 https://github.com/agegr/pi-web /tmp/pi-web` at the target tag.
2. `rsync -a --delete --exclude .git --exclude node_modules --exclude .next --exclude test-results /tmp/pi-web/ vendor/pi-web/`
3. Re-apply the fork diff from the file list above; conflicts mean the PRD's R9
   boundary leaked into upstream files — shrink the diff instead of growing it.
4. Run the upstream suite (`npm ci && npm test` in `vendor/pi-web`; `e2e/run.mjs`
   for the browser suite) and this repo's `npm run tidy`.
