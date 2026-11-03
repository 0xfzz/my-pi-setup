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
