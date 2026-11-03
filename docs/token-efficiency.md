# Token efficiency and prompt-cache stability

> Part of [pi-workflow-extensions](../README.md). What this package does so a request costs few tokens and so the provider's prompt cache keeps hitting.

| Field | Value |
| --- | --- |
| **Status** | current policy |
| **Scope** | `lib/dynamic-prompt.ts`, `lib/schema.ts`, `extensions/modes.ts`, `extensions/account-router.ts` |
| **Related** | [VCC](vcc.md), [accounts and router](accounts.md) |

A request is billed as `tools + system prompt + messages`, in that order, and a
provider cache matches the longest unchanged *prefix*. A byte that changes early
re-bills everything after it. The rules below follow from that.

## Rules

- **Nothing volatile in the prefix.** The system prompt carries no tool count and
  renders tools in a fixed order, so registering or removing one tool (a Plan
  switch, a late MCP connect) does not rewrite the preamble.
  `tests/dynamic-prompt.test.ts` pins order-independence.
- **Per-request reminders live at the tail and only when needed.** The
  `<current-input-mode>` message is sent only while Plan is active or the branch
  has Plan history that could be stale.
- **Tools are not described twice.** A tool without a `promptSnippet` is listed by
  name; its description already travels in the tool schema.
- **Schemas are compact.** String unions use `stringEnum` (`lib/schema.ts`), a flat
  `enum`, instead of an `anyOf` of `const`s.
- **Small windows get a compact prompt.** Below 48k context tokens the snippet cap
  drops to 60 characters and per-tool guideline bullets are omitted.
- **A pool keeps its account for a whole agent run.** Rotation (round-robin, LRU)
  happens between prompts, because a cache is scoped to the account that wrote it.
  A failing or cooling account is dropped at once.

## Breakpoints

A provider cache is opt-in per position: Anthropic stores a prefix only where a
`cache_control` marker sits, and allows four markers per request. Pi spends them
on the system prompt, the last tool definition and the last block of the final
message. The rules above keep the first two useful; the third is the one a long
session lives on, and it lands on whatever the last message happens to be.

Several extensions here append request-local text at that tail (the artifact
catalog, checkpoint snapshots, the todo line, the mode reminder). That text is
never resent, so a marker on it writes an entry nothing can read back, and every
request re-writes the whole conversation. Measured on one 87-request session:
24,335 tokens read on *every* request against 7.07M written in total, a 28%
hit rate, and not one token of conversation ever served from cache.

`lib/cache-anchor.ts` therefore plans all four markers, each on a different
lifetime:

| Marker | Position | Rewritten |
| --- | --- | --- |
| system prompt | last system block | when the prompt changes |
| last tool | last tool definition | when the tool set changes |
| the last real prompt | the user block carrying the prompt | once per turn |
| the last stable block | the block before the request-local tail | every request |

The prompt marker is what makes the cache hold: it sits at a position that
recurs unchanged in every later request of the turn, so in-turn growth cannot
outrun it. The rolling marker absorbs that growth, and it reaches back only
about twenty blocks — one large tool batch can pass it — which is exactly why it
is not the only one.

- **Declare request-local text.** Anything an extension appends to the tail goes
  through `markVolatileTail`; unmarked text is treated as stable and defeats the
  plan.
- **Never exceed four markers.** An OAuth request already carries two system
  markers, and the identity block's is redundant (its prefix is a subset of the
  next block's), so it is dropped first.
- **A skipped marker is reported, never inferred.** The sidebar's Cache section
  shows `breakpoint: no prompt` when a request had nothing to pin.

## Per-model profiles

`~/.pi/agent/dynamic-prompt.json` accepts `profiles`, keyed by `provider/model`, a
bare model id, or a `*` glob. Exact keys beat globs; a profile beats the
small-window default. `/dynamic-prompt <mode>` beats a profile for the session.

```json
{
  "mode": "replace",
  "profiles": {
    "anthropic/*": { "maxSnippetChars": 140 },
    "local/*": { "includeToolGuidelines": false, "maxSnippetChars": 50 }
  }
}
```

## Not done

Moving rarely used tools to Pi's `deferred` exposure would shrink the tool block
further, but a deferred tool is reachable only through `codemode` or tool search.
A session without either would lose delegation, so it is not enabled.
