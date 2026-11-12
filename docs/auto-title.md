# Auto title: naming a session from its work

> Part of [pi-workflow-extensions](../README.md). How a session gets a short title generated from its own opening exchange and work, on the session's current model, and how to control it.

| | |
| --- | --- |
| **Status** | current operator guide |
| **Detail for** | [README § Documentation](../README.md) |
| **Scope** | `extensions/auto-title.ts`, `lib/title/*`, `lib/auto-title-web-view.ts`, `web-plugins/auto-title.ts`, `web/server/sessions.ts` (names), `web/client/sidebar.tsx` and `shell.tsx` (display) |
| **Verified against** | `tests/auto-title-extension.test.ts`, `tests/title-brief.test.ts`, `tests/title-clean.test.ts`, `tests/title-provenance.test.ts`, `tests/title-flag-store.test.ts`, `web/server/session-names.test.ts`. Not verified against a real model or in a browser: the sidebar and header are covered by the data-path tests only |
| **Related** | [Dashboard](dashboard.md) (`session_goal` and `/name` set the same name), [pi-web](pi-web.md), [PRD](prds/session-title-generation.md) |

- **What it is** — a pi extension that names a session after its first exchange and refines it once more when the work grows, plus the web sidebar and header that show the name in place of the folder.
- **Why it exists** — a folder name tells you nothing about the work; the picker and the sidebar need a topic. Titles were invisible on the web and could not be refined.
- **How it is enforced** — `lib/title/policy.ts` decides every attempt; each generated title is recorded on the branch (`workflow-title:v1`) before it is applied, so the dashboard never mistakes it for a person's rename.
- **What it refuses** — replacing a name you set; titling child sessions; a third automatic try; a title that echoes your message, contains a path, URL or identifier, or is generic.
- **What it cannot do** — judge title quality. Nothing measures whether a title is good; the failure cases are checked by property tests, not by a model.

---

## Detail

### What is sent

One completion on the session's **current model**, through `ctx.modelRegistry.streamSimple`, with the request options from `lib/title/model-options.ts`:

| Part | Content |
| --- | --- |
| System prompt | 3–6 words, the user's language, no quotes or markdown, `KEEP` when a current title still fits. The brief is data, never instructions |
| Brief | `goal`, `first_user`, `first_assistant`, `latest_user` (refinement only), `compaction`, `footprint`, `current_title` (refinement only), `hint` (manual only). About 3,000 characters at most |
| Never sent | system prompts, tool output, thinking, file contents, environment values. Images and files appear only as `[attachment: type]` |
| Redacted | `sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, and long hex or base64 runs |
| Budget | 64 output tokens with thinking off; a model that cannot turn thinking off gets its lowest level and 8,192 tokens (reasoning is counted inside the same budget). A `length` stop retries once at four times the budget, then the partial text is handed to the cleaner — empty or unusable text fails as its named rejection |
| Routing | `cacheRetention: "none"` (a one-off, so `claude-bridge` routes it around prompt capture), `maxRetries: 0`, 20 s timeout |

### When it runs

| Trigger | Result |
| --- | --- |
| A turn settles and the session has no name, with a substantive question and a reply | **Provisional** title |
| A turn settles, the name is the generated one, a committed plan exists or the session has four or more user turns with file work, and no refinement has run | **Refinement**: rewrites the name, or `KEEP` leaves it and spends the pass |
| `/title now [hint]` or the web **Regenerate** action | **Manual**: replaces the name, ignores the cap and the lock, not the cooldown (10 s) or a request in flight |

Automatic tries are capped at **three per session**, failures included. The count lives on the branch, so it survives a reload.

### Ownership

- A name equal to the latest generated title is **generated**. Anything else is **yours**: `/name`, `session_goal`, or a web rename.
- A name you set locks the automatic path for that session. A generated name you clear is not written again.
- `/title lock` marks a generated name as yours in effect: no refinement runs. It is recorded as an attempt.
- A name set while a request is in flight wins; the result is discarded and recorded as `superseded`.

### Controls

| Control | Effect |
| --- | --- |
| `/title` · `/auto-title` | Same commands. `status` shows the name, its source, tries and the last error |
| `/title now [hint]` | Generate now. The hint is data inside the brief |
| `/title on` · `off` | Persisted choice in `~/.pi/agent/auto-title.json`. `off` aborts a request in flight |
| `/title lock` | Keep the current generated title for good |
| `PI_AUTO_TITLE=0` | Start this process with auto titles off; the stored choice is not changed |
| Web **Regenerate title** · **Toggle auto title** | Same as `now` and `on`/`off` |

### Where the name shows

- **Sidebar** — the row's label is the session name, or the folder when it has none. The folder moves to the meta line. Search matches the name.
- **Header** — the selected session's name, with the folder in the tooltip.
- **Terminal title and `/resume`** — pi's own, through `setSessionName`.
- **Card** — Auto title, Status (`Locked (you named it)` for your own name), Title, Source, Model, Generations `n / 3`, Last error.

Names reach the browser on the session directory stream as `session_renamed` frames. A disk-only session's name is read from its latest `session_info` entry by reading the file backwards in 64 KB steps, up to 4 MB, cached by mtime. A name deeper than 4 MB is not shown.

### What it cannot do

- It does not re-title on topic drift. Use `/title now` or `session_goal`.
- It does not call a cheaper model. `titleModel` is an open question in the PRD.
- The web header has no inline rename or regenerate button yet; `/name` and the card action cover both.
- The `scripts/eval-titles.mjs` live-model evaluation from the PRD is not written. Quality is not measured.

## Tests

- `tests/title-brief.test.ts` — substance filter, code collapse, redaction, tag neutralisation, caps, attachments, footprint, compaction, the natural-language floor.
- `tests/title-clean.test.ts` — the accept and reject table, echo, `KEEP`, length bound, policy transitions, cap, cooldown, refinement trigger, request budgets.
- `tests/title-provenance.test.ts` — record ownership and attempt counting.
- `tests/auto-title-extension.test.ts` — the lifecycle end to end with a fake pi and model: provisional, refinement, `KEEP`, lock, failure cap, in-flight rename, toggle, persisted choice, card rows, child sessions.
- `web/server/session-names.test.ts` — disk name scan (far from the end, cleared, chunk boundary), live rename dedupe.

Not covered: a real model's output, browser rendering of the sidebar and header, and the bridged (TUI-owned) rename path end to end.

## Removal

Remove `./extensions/auto-title.ts` from `package.json` `pi.extensions`. The web descriptor stays harmless without it. Names already set stay in the session files like any other name. Delete `~/.pi/agent/auto-title.json` to forget the stored choice.
