# Questions: ask the user, or ask the main agent

> Part of [pi-workflow-extensions](../README.md). When the agent must ask, how a child routes a question, and what is never consent.

Tool: **`ask_user`**. Ask about consequential ambiguity, missing requirements, conflicting instructions, or unavailable information—not facts that can be checked using available tools, and not routine confirmations already authorized by the request.

In the main session, `ask_user` opens the shared popup: the question and context stay visible, options scroll, and one option can be marked **`(recommended answer)`** with the optional `recommended` (1-based) parameter. The marker is never preselected or auto-submitted. A **“Type your own answer…”** row is always present, and empty input is rejected. RPC/print sessions fall back to Pi's native select/input dialogs. In a Herdr child, questions route through the existing **`agent_ping`** tool; no direct user dialog, sidecar duplication, parallel question transport, or change to the Herdr plugin. The parent receives the question and child session path, answers from existing context when possible, otherwise calls `ask_user`, then resumes the child with `agent_resume` and the answer. This is Herdr's exit-and-resume handshake, not a child blocking forever on a new RPC channel.

Cancelled/unavailable input is not an answer or consent. The AI must keep dependent work blocked and report missing information. Non-interactive sessions must not invent user answers. Agent definitions that explicitly restrict tools must allow `ask_user` in the parent and `agent_ping` in the child; the extensions do not override those restrictions.

**Guidance is injected only when it applies.** A Herdr child always receives the child-side rules, because they constrain tools it can reach at any moment. The parent receives the ping-handling rules **only on a `subagent_ping` turn** — not on every turn. Injecting them unconditionally made the rules read as a standing assignment, so a bare `test` arrived with hidden instructions about answering pings and resuming children and was answered with a protocol recital instead of an acknowledgement.
