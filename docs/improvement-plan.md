# Architectural Improvement Plan: Dynamic AI Todo List System

| Field | Value |
| --- | --- |
| **Status** | proposal (dated October 2026) |
| **Detail for** | [README § Conditional todo list](../README.md) |
| **Scope** | `extensions/todo.ts`, `lib/todo-tools.ts` |
| **Verified against** | design document; the shipped surface is described in README |
| **Related** | [Todo concept](TODO-CONCEPT.md) |

---

## 1. Executive Summary

### 1.1 The Challenge
Modern coding agents rely heavily on task checklists (todo lists) to maintain focus across multi-step software engineering challenges. However, the current `workflow_todo` extension in `pi-workflow-extensions` suffers from architectural rigidity:
- **Single-Action RPC Model:** Every mutation requires a distinct tool call (`update` step 1 -> wait for tool result -> `update` step 2 -> wait for tool result).
- **Two-Step Transition Lock:** Because only one item can be `in_progress` at any time, moving from one step to the next forces a jarring two-step round-trip. If an agent tries to activate the next step before completing the current one, the extension rejects it; if it forgets to activate the next step, the pre-tool guard blocks subsequent shell/edit actions.
- **Plan Immutability:** Agents cannot dynamically edit the text of existing tasks, insert steps into the middle of a list, reorder tasks based on new findings, or cancel an individual task without wiping out the entire plan.
- **Model Frustration & Friction:** Frontier models (Claude 3.7 Sonnet, Claude Opus, GPT-5, Qwen 2.5 Coder) naturally think dynamically. Constraining them to micro-RPC commands often triggers administrative thrashing, repetitive tool ping-pong, and edge-case continuation loops.

### 1.2 The OpenCode & Industry Paradigm
In contrast, modern agents like **OpenCode** (`todowrite`) and **Claude Code** (`TodoWrite` / `Task*` APIs) implement **dynamic, atomic task management**:
1. **Atomic Full-List Synchronization:** The agent can pass the entire updated checklist in a single tool call (`todowrite({ todos: [...] })`). Status updates, task description refinements, newly discovered subtasks, and completed items are all synced in one shot.
2. **Dynamic Adaptation:** As agents explore files and encounter unexpected complexities, they can refine existing task descriptions, reorder priorities, or drop obsolete steps without breaking the workflow.
3. **Strict Single-Task Invariant:** Exactly one task is marked `in_progress` at any given time, providing laser focus without administrative overhead.

### 1.3 Core Objective
Transform Pi's `workflow_todo` into a **dynamic task orchestration engine** matching OpenCode's fluidity and Claude Code's discipline, while introducing **rock-solid stability guardrails** so the todo list never becomes unstable, hallucinatory, or prone to infinite continuation loops.

---

## 2. Comparative Benchmark & Industry Analysis

| Capability / Feature | Pi Current (`workflow_todo`) | OpenCode (`todowrite`) | Claude Code (`TodoWrite` / `Task*`) | Proposed Pi Target (`workflow_todo` Dynamic) |
| :--- | :--- | :--- | :--- | :--- |
| **Mutation Paradigm** | Granular RPC (`plan`, `update`, `add`, `cancel`, `skip`, `continue`) | Atomic array replacement (`todos: [...]`) | Dual: Historical `TodoWrite` array + modern granular `Task*` CRUD | **Hybrid**: Atomic full-array `sync` + granular actions (100% backward compatible) |
| **Step Hand-off Overhead** | **2 full turns** (Mark #1 done, mark #2 in_progress) | **1 atomic call** (Simultaneous completion & activation) | **1 atomic call** (or direct task state transitions) | **1 atomic call** (Simultaneous mark done + next in_progress) |
| **Task Description Editing**| ❌ Not supported (Immutable once created) | ✅ Fully supported (Rewrite item `content`) | ✅ Supported (Update task description) | ✅ Fully supported (`text` / `content` edits preserved) |
| **Task Reordering & Splitting**| ❌ Append-only (`add` at end) | ✅ Fully supported (Reorder array at will) | ✅ Supported via dependencies/subtasks | ✅ Fully supported (Array order determines priority) |
| **Individual Cancellation** | ❌ All-or-nothing (`cancel` cancels all) | ✅ Supported (Remove item or mark `cancelled`) | ✅ Supported (Mark individual task `cancelled`) | ✅ Supported (Per-item cancellation with reason) |
| **Active Continuous Form** | ❌ Only static title | ⚠️ Implicit | ✅ Dual form (`content` imperative + `activeForm` continuous) | ✅ Dual form (`text` + optional `activeText` for TUI spinner) |
| **Persistence Layer** | Session Custom Entries (`workflow-todo:v1`) | In-memory session (v2.1.0 experimental) | Filesystem (`~/.claude/tasks`) | Session Custom Entries (Durable across branches/reloads) |
| **Context Injection Overhead**| ✅ Bounded (`compactState`, <=3 items, 1600c) | ⚠️ Re-injects active list in system prompt | ⚠️ Re-injects tasks in system prompt | ✅ Bounded priority compaction (Zero token bloating) |
| **Subagent Isolation** | ✅ Full branch & header UUID isolation | ⚠️ Shared or subagent-restricted | ✅ Shared via `CLAUDE_CODE_TASK_LIST_ID` | ✅ Full branch & header UUID isolation (Herdr compatible) |
| **Loop Circuit Breakers** | ⚠️ Bounded retry counter + repetition heuristics | ❌ None (Relies on provider timeout) | ⚠️ Turn-level reminders | ✅ Multi-layer fail-open circuit breaker + diff analysis |

---

## 3. Deep Diagnosis: Current Friction Points & Instability Risks

To ensure we build a stable system ("so we don't end up with an unstable todolist"), we must analyze the exact root causes of instability in the current codebase:

### 3.1 The "Two-Step Hand-off" Tool Ping-Pong
**Problem:** In `todo.ts`, line 440:
```ts
if (args.status === "in_progress" && next.items.some(i => i.id !== item.id && i.status === "in_progress")) {
  throw new Error("Finish, pause, or block the current step before starting another.");
}
```
And line 526:
```ts
if (!simpleResponse && state.items.length && actionable(state).length && !state.items.some(i => i.status === "in_progress")) {
  roundAdmin = true;
  return { block: true, reason: "Set the next todo in_progress before doing more work." };
}
```
**Consequence:**
When Step 1 finishes:
1. Turn N: Agent calls `workflow_todo({ action: "update", id: 1, status: "done", evidence: "..." })`.
2. Agent wants to run `read` or `edit` for Step 2.
3. Pre-tool hook intercepts and blocks: `"Set the next todo in_progress before doing more work."`
4. Turn N+1: Agent is forced to call `workflow_todo({ action: "update", id: 2, status: "in_progress" })`.
5. Turn N+2: Agent can finally read the file.
This creates unnecessary token consumption, adds latency, and increases the risk of tripping `adminRounds >= 3` loop steers.

### 3.2 Plan Rigidity vs Real-World Discovery
**Problem:** In real coding, the agent does not have complete information at the start.
- An agent plans: `["Step 1: Check auth", "Step 2: Add OAuth callback handler", "Step 3: Test OAuth"]`.
- In Step 1, it discovers that OAuth callback handler is already written in `src/auth/oauth.ts`, but the JWT cookie signing is broken.
- Current behavior: The agent cannot edit Step 2 or delete it. It can only `add` Step 4: `"Fix JWT cookie"`. Step 2 remains an awkward zombie item. If the agent marks Step 2 `done`, it must invent evidence; if it cancels Step 2, the current `cancel` action cancels *everything*.

### 3.3 The Threat of Dynamic Instability (What Must Be Prevented)
When opening up a todo list to dynamic updates (allowing the model to rewrite or replace items), naive implementations fail in catastrophic ways:
1. **Hallucination Thrashing:** The model gets confused, wipes out its previous checklist, and generates a completely unrelated plan every turn.
2. **Premature Done Inventions:** The model marks tasks `done` without actually running shell commands or editing files.
3. **Continuation Loop Deadlocks:** The agent outputs partial text, halts, the harness continuation injects a reminder, the agent outputs more text without tools, leading to runaway API calls.
4. **Context Window Rot:** The agent expands the todo list to 40 items with 100-word descriptions each, blowing up the prompt tokens on every turn.

---

## 4. Architectural Design: The Stable Dynamic Todo Engine

### 4.1 Core Design Principles
1. **Atomic Agility:** Allow agents to sync their desired checklist state in a single call.
2. **Monotonic Integrity:** Tasks marked `done` are cryptographically/logically locked. The model cannot silently un-complete or delete finished work without explicit justification.
3. **Strict Invariants:** Exactly one task `in_progress` at any time during active execution.
4. **Zero-Friction Transitions:** Allow simultaneous completion of the current task and activation of the next task in the exact same tool call.
5. **Universal Compatibility:** Preserve existing `skip`, `plan`, `continue`, `update`, `add`, `cancel`, `list` signatures so existing test suites (465 tests) and workflows run without modification.

### 4.2 Unified Tool Schema Specification

We expand `workflow_todo` to accept either granular commands OR an atomic array of `todos`:

```ts
import { Type } from "typebox";

export const TodoStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("done"),
  Type.Literal("blocked"),
  Type.Literal("waiting"),
  Type.Literal("cancelled"),
]);

export const TodoItemInputSchema = Type.Object({
  id: Type.Optional(Type.Integer({ minimum: 1, description: "Existing ID for updates, or omitted for new items" })),
  text: Type.String({ minLength: 1, maxLength: 500, description: "Task description (imperative form)" }),
  activeText: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "Present continuous form displayed while running" })),
  status: TodoStatusSchema,
  evidence: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "Proof of completion (required when status is done)" })),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "Reason (required when status is blocked, waiting, or cancelled)" })),
});

export const WorkflowTodoParameters = Type.Object({
  // Action discriminator: 'sync' for dynamic full-array sync, or legacy RPC actions
  action: Type.Optional(Type.Union([
    Type.Literal("sync"),     // New dynamic full-list replacement/sync
    Type.Literal("skip"),     // Mark request simple (no plan)
    Type.Literal("plan"),     // Initial plan creation
    Type.Literal("continue"), // Resume retained plan
    Type.Literal("add"),      // Append single item
    Type.Literal("update"),   // Modify single item status/evidence
    Type.Literal("modify"),   // Edit text/details of existing item
    Type.Literal("cancel"),   // Cancel scope
    Type.Literal("list"),     // Read paginated list
  ])),

  // Dynamic Array Input (OpenCode/Claude Code alignment)
  todos: Type.Optional(Type.Array(TodoItemInputSchema, {
    minItems: 1,
    maxItems: 50,
    description: "The complete, dynamically updated todo list (atomic sync)",
  })),

  // Legacy & Granular Parameters (Fully Retained)
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  steps: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 2, maxItems: 30 })),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  activeText: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  id: Type.Optional(Type.Integer({ minimum: 1 })),
  status: Type.Optional(TodoStatusSchema),
  evidence: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});
```

### 4.3 Atomic Transition Mechanics (`action: "sync"` or `todos: [...]`)

When an agent invokes `workflow_todo({ todos: [...] })` or `{ action: "sync", todos: [...] }`:
1. **Identifier Reconciliation:**
   - Existing items match on `id`.
   - Items without an `id` receive the next available auto-incremented ID (`nextId++`).
   - If the model reorders items, the new order is respected in the TUI and internal priority list.
2. **Completion Lock (Monotonic Progress):**
   - If an item was previously `status: "done"`, it CANNOT be changed back to `pending` or deleted unless the call explicitly includes a `reason` explaining why earlier work must be reopened.
3. **Atomic Hand-off Validation:**
   - The array is evaluated as a whole.
   - Example valid atomic transition:
     - Item 1: `status: "done", evidence: "Tests pass in test/auth.test.ts"`
     - Item 2: `status: "in_progress"`
     - Item 3: `status: "pending"`
   - Result: Step 1 becomes `done` AND Step 2 becomes `in_progress` in a **single turn**. The subsequent tool call (`edit`, `bash`) is immediately permitted without blocking!
4. **Single-Active Invariant Enforcement:**
   - If more than one item in `todos` is set to `in_progress`, the call rejects with:
     `"Only ONE task can be in_progress at any time. Mark other tasks pending, done, or blocked."`
   - If zero items are `in_progress`, but actionable items exist, the engine automatically sets the first pending item to `in_progress` if the agent is starting work, or allows zero if the plan is completed/blocked.

---

## 5. Stability & Guardrail Architecture

To ensure the system never creates an unstable or runaway todo list, the following stability layers are implemented:

```
+-------------------------------------------------------------------------+
|                         LLM Reasoning Layer                             |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
|             Layer 1: Structural & Monotonic Schema Guard                |
|  - Validates single in_progress invariant                               |
|  - Enforces evidence for 'done' and reasons for 'blocked'/'waiting'     |
|  - Locks completed tasks against accidental regression / deletion       |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
|             Layer 2: Administrative Loop Circuit Breakers               |
|  - Detects redundant todo-only calls without code/terminal work          |
|  - Tracks adminRounds; injects model-visible corrective steer           |
|  - Fails open after 2 steers to prevent deadlock or stall               |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
|             Layer 3: Boundary & Continuation Protectors                 |
|  - Bounded turn_end continuation (Max 1 reminder per user turn)         |
|  - Suppressed continuation when asking user questions (ends in '?')      |
|  - Immediate break on text repetition or todo-list echoing              |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
|             Layer 4: Context Compaction & Branch Isolation              |
|  - Session Custom Entries ('workflow-todo:v1') persisted on branch     |
|  - Injected prompt context capped at 3 priority items (<= 1600 chars)   |
|  - Header UUID isolation prevents child subagents from corrupting state |
+-------------------------------------------------------------------------+
```

### 5.1 Layer 1: Monotonic Completion & Evidence Guard
- An agent cannot simply mark all tasks `done` in an instant. Every `done` status MUST be accompanied by an `evidence` string (minimum 1 character, recommended concise proof like file path or test result).
- Completed tasks cannot be quietly dropped from the array. If an incoming `todos` array omits an item that was previously `done`, the engine automatically re-attaches the completed item to preserve historical evidence.

### 5.2 Layer 2: Loop Breakers & Fail-Open Resilience
- **Admin Counter (`adminRounds`):** If an agent executes 3 consecutive turns of only `workflow_todo` administration without executing real work tools (`bash`, `edit`, `write`, `browser`, `read`), the harness intervenes.
- **Progress Steer:** It injects:
  `"Repeated todo-only calls are not progress. Execute the current step now with real tools. Update the todo only when the step is genuinely done or blocked."`
- **Fail-Open Safety:** If the model still attempts real work, the guard does NOT block it. It fails open after 2 steers so that the harness itself never becomes the obstacle.

### 5.3 Layer 3: Turn-End Continuation & Question Detection
- If an agent ends its turn with items still `in_progress`, the harness checks:
  1. Did the assistant ask the user a question (`isAskingUser(text)`)? If yes, **do not continue**; wait for the user to answer.
  2. Are all items `done` or `cancelled`? If yes, **do not continue**; the task is finished.
  3. Is the assistant's response identical to the previous turn (repetition loop)? If yes, **break loop immediately** and notify.
  4. Is the assistant merely echoing the todo list text without executing tools? If yes, **break loop immediately**.
  5. Otherwise, inject exactly ONE continuation reminder:
     `"Unfinished todo step X: execute this step using work tools. Do not call workflow_todo unless updating a completed step with evidence."`
  6. Hard cap: Max 1 continuation reminder. If work is still incomplete, post a warning notification and cleanly yield to the user.

### 5.4 Layer 4: Context Compaction
- Full todo state lives in Pi session custom entries (`workflow-todo:v1`) and the TUI sidebar widget.
- The prompt context only ever receives a bounded snapshot via `compactState()`:
  - Top active item (`in_progress`).
  - Next blocked/waiting items.
  - Omitted count and done ratio.
  - Maximum payload size strictly capped under 1,600 characters regardless of whether there are 5 or 50 items.

---

## 6. Implementation Blueprint: Code Modifications

### 6.1 Schema & Type Expansion in `extensions/todo.ts`

```ts
// Enhanced Item interface supporting dynamic text edits and active forms
interface Item {
  id: number;
  text: string;
  activeText?: string;
  status: Status;
  note?: string;
}

// Support both atomic sync and legacy actions
export const WorkflowTodoParameters = Type.Object({
  action: Type.Optional(enumOf(["skip", "plan", "continue", "add", "update", "modify", "cancel", "list", "sync"])),
  todos: Type.Optional(Type.Array(Type.Object({
    id: Type.Optional(Type.Integer({ minimum: 1 })),
    text: Type.String({ minLength: 1, maxLength: 500 }),
    activeText: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    status: enumOf(["pending", "in_progress", "done", "blocked", "waiting", "cancelled"]),
    evidence: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  }), { minItems: 1, maxItems: 50 })),
  // ... legacy parameters retained ...
});
```

### 6.2 Atomic Sync Execution Logic

```ts
case "sync":
case undefined: {
  // If 'todos' array is provided, perform atomic synchronization
  if (args.todos && args.todos.length > 0) {
    const incoming = args.todos;
    
    // 1. Validate Single in_progress Invariant
    const inProgressCount = incoming.filter(i => i.status === "in_progress").length;
    if (inProgressCount > 1) {
      throw new Error("Only ONE task can be in_progress at any time. Mark others pending, done, or blocked.");
    }

    // 2. Preserve completed items and historical evidence
    const existingDone = new Map(state.items.filter(i => i.status === "done").map(i => [i.id, i]));
    const nextItems: Item[] = [];
    let nextId = state.nextId;

    for (const item of incoming) {
      const id = item.id ?? nextId++;
      const note = item.status === "done" ? item.evidence?.trim() : item.reason?.trim();
      
      // Enforce evidence/reasons
      if (item.status === "done" && !note && !existingDone.has(id)) {
        throw new Error(`Task "${item.text.slice(0, 40)}" marked done requires evidence.`);
      }
      if (["blocked", "waiting", "cancelled"].includes(item.status) && !note) {
        throw new Error(`Task "${item.text.slice(0, 40)}" marked ${item.status} requires a reason.`);
      }

      nextItems.push({
        id,
        text: item.text.trim(),
        activeText: item.activeText?.trim(),
        status: item.status,
        note: note || existingDone.get(id)?.note,
      });
    }

    // 3. Ensure any omitted completed items are not lost
    for (const [doneId, doneItem] of existingDone.entries()) {
      if (!nextItems.some(i => i.id === doneId)) {
        nextItems.unshift(doneItem); // Re-anchor completed history
      }
    }

    next.items = nextItems;
    next.nextId = Math.max(nextId, ...nextItems.map(i => i.id)) + 1;
    next.assessed = true;
    simpleResponse = false;
    roundWork = true; // Meaningful atomic progress
    adminRounds = 0;
    break;
  }
}
```

### 6.3 Dedicated `modify` Action (Fine-Grained Editing)

```ts
case "modify": {
  if (!args.id) throw new Error("modify requires an item id.");
  const item = next.items.find(i => i.id === args.id);
  if (!item) throw new Error(`Item ${args.id} not found.`);
  
  if (args.text?.trim()) item.text = args.text.trim();
  if (args.activeText?.trim()) item.activeText = args.activeText.trim();
  if (args.reason?.trim()) item.note = args.reason.trim();
  break;
}
```

### 6.4 Auto-Handoff Pre-Tool Hook Optimization
In `todo.ts`, update `pi.on("tool_call")`:
```ts
// If all previous tasks are done and no task is in_progress, but pending tasks exist:
// Instead of hard-blocking the agent, auto-advance the first pending task to in_progress!
if (!simpleResponse && state.items.length && actionable(state).length && !state.items.some(i => i.status === "in_progress")) {
  const nextPending = state.items.find(i => i.status === "pending");
  if (nextPending) {
    nextPending.status = "in_progress";
    persist(ctx);
    // Allow tool to run smoothly without blocking turn!
    return;
  }
}
```
*Impact:* This eliminates the most annoying bottleneck in the current extension—the agent can transition from Step 1's completion directly into executing Step 2 without needing a separate turn just to flip a status bit!

---

## 7. Migration & Phased Rollout Plan

### Phase 1: Dynamic Batch Schema & Atomic Handoffs (Week 1)
- Add `todos` array parameter and `action: "sync"` to `WorkflowTodoParameters`.
- Implement atomic validation: simultaneous `done` + `in_progress` transition.
- Implement monotonic completion protection (preserve finished tasks and require evidence).
- Maintain 100% backward compatibility with all 465 existing tests.

### Phase 2: Description Modification & Per-Item Cancellation (Week 1)
- Add `modify` action for in-place text and `activeText` editing.
- Allow per-item status update to `cancelled` with an explicit reason without cancelling sibling tasks.
- Add auto-advance logic in `tool_call` so agents are never blocked when moving to the next pending step.

### Phase 3: UI & TUI Polish (Week 2)
- Update `PopupPanel` and sidebar rows: display `activeText` when a task is running (e.g. `󰑐 Running tests...`).
- Add keyboard shortcuts in the Alt+W T popup to toggle item details, jump to active steps, and view evidence.
- Ensure zero terminal flicker during atomic array syncs.

### Phase 4: Stress-Testing & Validation (Week 2)
- Add adversarial test suites:
  - 50-item dynamic array sync.
  - Rapid task reordering and description rewriting.
  - Subagent fork isolation under dynamic sync.
  - Loop detection and circuit breaker fail-open verification.

---

## 8. Risk Assessment & Mitigations

| Risk | Probability | Impact | Mitigation Strategy |
| :--- | :---: | :---: | :--- |
| **Model Array Truncation** (Large plan gets accidentally trimmed) | Low | High | Monotonic check: Any completed (`done`) item missing from the incoming array is automatically restored from previous state. |
| **Schema Validation Errors** (Model formats nested JSON improperly) | Medium | Medium | Flexible parsing: Accept either root `todos` array or legacy arguments; handle stringified JSON safely. |
| **Infinite Continuation Loops** (Agent doesn't finish in_progress tasks) | Low | High | Strict limit of 1 turn_end reminder; repetition detection; automatic yield on user-directed questions. |
| **Backward Incompatibility** (Breaks existing Pi extensions/skills) | Very Low | Critical | All existing actions (`plan`, `update`, `skip`, `continue`, `add`, `cancel`, `list`) remain functional and verified by automated regression tests. |

---

## 9. Conclusion
By adopting OpenCode's **atomic array synchronization** and Claude Code's **single-active task discipline**, combined with Pi's **durable session persistence** and **fail-open circuit breakers**, this improvement plan provides a truly dynamic, production-grade AI task orchestration system.

The resulting system eliminates tedious tool ping-pong, empowers the agent to adapt dynamically to code discoveries, and guarantees that the todo list remains stable, reliable, and completely loop-free.
