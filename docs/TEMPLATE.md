# Design note template

Every document in `docs/` follows this shape. README indexes it in one row; the file is
the detail.

```md
# <Title: what the document is about, not what it hopes>

| Field | Value |
| --- | --- |
| **Status** | current reference · current operator guide · historical record · proposal · implemented fix record · verification record |
| **Detail for** | [README § <section>](../README.md) |
| **Scope** | the files or areas this document is authoritative about |
| **Verified against** | commit, runtime version, or command — or "not re-verified" |
| **Related** | other notes that must be read with this one |

## Summary

- Three to five bullets. The conclusion, not the journey.
- One claim per bullet; no bullet that only announces a section.
- If a bullet is superseded, say so here and link the note that supersedes it.

---

## Detail

The original body, with its own numbered sections. A reader who trusts the summary
should not need this; a reader who has to act on it does.
```

## Rules

1. **Status is a claim, not decoration.** `historical` means do not implement from it
   without checking the current tree. `proposal` means it describes something that may not
   exist. `current` means a change that contradicts it is a bug or a deliberate revision.
2. **`Verified against` is a fact.** If the document was not re-checked in the current
   tree, say so. A stale verification claim is worse than none.
3. **The summary is written last.** It states what a reader should conclude, not which
   sections exist.
4. **One subject per file.** If a document grows a second subject, split it and link the
   halves in `Related`.
5. **No duplication with README.** README carries a one-line summary per note; the note
   carries the reasoning. If both say the same thing at length, the note loses.
6. **Historical documents stay honest.** Do not rewrite an audit to match the current tree;
   add a `Superseded by` line to the summary and leave the evidence intact.

## Adding a note

1. Copy the template, set `Status` and `Detail for`.
2. Write the detail body first.
3. Write the summary from the body, in conclusions.
4. Add one row to the README **Design notes** table.
5. Link it from the README section it belongs to, if that section has a natural place for it.
