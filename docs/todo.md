# Conditional todo list

> Part of [pi-workflow-extensions](../README.md). The `workflow_todo` guardrail: assessment, atomic sync, evidence, and loop correction.

Tool: **`workflow_todo`**. Command: **`/workflow-todos`**.

**Keyboard details:** press **Alt+W**, release, then **T** for todos, **S** for subagents, or **E** for artifact details (no Enter). **Esc** cancels the prefix menu. `/workflow` opens the same menu. Todo and subagent details open as bordered pickers that drill into bordered markdown/text detail popups (`↑↓/jk`, `Enter`, digits `1`–`9`, `Esc`); artifact details open the artifact viewer's markdown popup described under [Workspace Artifacts](artifacts.md). This keyboard path works in regular and fullscreen TUI modes, including when `/sidebar off` hides the rail; terminal mouse clicks work only in fullscreen. The prefix is registered by `extensions/sidebar.ts`; standalone todo/subagent extensions retain `/workflow-todos` and `/subagents`.

- Text-only replies and clarification questions need no assessment tool call. Before using work tools, the main AI assesses the current request. `skip` records a short simplicity reason (with a default if omitted) without making a list or showing a widget. `plan` creates concrete steps for multi-step work, with the first step already in progress. `continue` preserves an unfinished plan.
- **Dynamic Atomic Sync**: The AI can pass an entire updated checklist in a single tool call via `todos: [...]` (or `action: "sync"`). This supports simultaneous step completion and next-step activation in one turn (zero-turn handoff), dynamic task description editing, reordering, and item insertion.
- Before normal tools can run, the request must be assessed. Clarification, parent pings, interruption, and tool discovery remain available. Nested/codemode tool calls pass through the same Pi tool hooks.
- Only one item can be `in_progress` at any time. In dynamic mode, completing a step and calling a work tool automatically advances to the next pending step without blocking.
- `done` requires an evidence note. Completed items cannot be silently removed or reopened without a reason.
- `modify` allows in-place task description, continuous activeText (`activeText`), or reason/note editing.
- `cancel` supports both global scope cancellation and per-item cancellation (by providing `id`).
- On a premature final response with an actionable unfinished plan, a `turn_end` boundary requests continuation. It does not reopen a plain reply just to record a skip or invent a task to resume. This boundary is deliberately before Herdr's child `agent_end` auto-exit; a final-settlement-only hook would be too late.
- Genuine `blocked` and `waiting` states require reasons and allow yielding. They are **not completed**. The AI should report them honestly and update them when input/results arrive. Parent completion is blocked while unresolved items remain; a child may still `agent_ping` for help.
- New user requests take priority, but preserve unfinished plans. The AI can add a step and continue. Explicit scope cancellation is recorded, not silently cleared.
- State lives in Pi session custom entries, reconstructed from the **active branch**, not a global file. Reload, resume, fork/tree navigation, and normal compaction retain the plan. Separate sessions have independent state.
- No extra classifier model, inference bill, keyword guesser, timers, filesystem watcher, network, or polling. The existing AI judges complexity.

Example actions:

```json
{"action":"skip","reason":"Single factual answer; no work plan needed"}
{"action":"plan","steps":["Inspect the relevant code","Implement the change","Run focused tests"]}
{"todos":[{"id":1,"text":"Inspect code","status":"done","evidence":"Found src/login.ts"},{"id":2,"text":"Implement change","activeText":"Refactoring login auth","status":"in_progress"},{"id":3,"text":"Run tests","status":"pending"}]}
{"action":"modify","id":2,"text":"Refactor login authentication handlers","activeText":"Refactoring auth handlers"}
{"action":"update","id":1,"status":"done","evidence":"Inspected src/login.ts and its tests"}
{"action":"update","id":2,"status":"in_progress"}
{"action":"update","id":2,"status":"blocked","reason":"Need the user's choice of authentication provider"}
{"action":"cancel","id":3,"reason":"Scope removed by user"}
```

### Safety and limits

This is a workflow guardrail, not a permission sandbox or a proof of correctness. It enforces the declared plan's structure, not the truth of the AI's complexity assessment or evidence notes. An AI can still misjudge a task or claim inaccurate evidence. Final-answer reminders are capped at one per run to prevent costly infinite loops, and never continue errors or aborts. Each continuation adds a model-visible reminder entry, providing the runnable context Pi requires. At the cap, Pi warns that work is incomplete; it does not mark it done. The initial premature text can already have streamed before the continuation hook fires.

**Loops are corrected, never stopped.** When several consecutive turns contain only `workflow_todo` administration (list, continue, redundant status churn) and no real work, the guardrail does not abort or terminate the run. It instead:

1. injects a model-visible steer telling the assistant to run the current step with real tools and to stop repeating `workflow_todo`;
2. refuses the redundant administrative call for that turn so the steer cannot be ignored;
3. **fails open**: after a few steers the guardrail stops refusing and lets the agent's chosen call run, so the guard itself can never become the cause of a stall.

The plan, all evidence, and all unfinished work are always retained. Real work (or an explicit milestone: `plan`, `skip`, `cancel`, or an `update` to `done`/`blocked`/`waiting`) resets the counter immediately, so ordinary progress never trips the guard. Only intentional yields — a forwarded `ask_user`/`agent_ping` — end a turn early.

The user can always press Escape. To drop removed scope explicitly:

```text
/workflow-todos cancel requirements changed
```
