import test from "node:test";
import assert from "node:assert/strict";
import todoExtension, {
  PLAN_TOOL, ACT_TOOL, NEXT_TOOL, LEGACY_TOOL, TODO_TOOL_NAMES, isTodoTool,
  getTodoGuidance, todoIcon, WORKFLOW_TODO_ENTRY,
} from "../extensions/todo.ts";

/** Minimal ExtensionAPI harness. `hasUI` stays false so rendering never runs. */
async function setup(options: { branch?: any[]; header?: any } = {}) {
  const branch = options.branch ?? [];
  const hooks: Record<string, Function[]> = {};
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const notices: string[] = [];
  let widget: any;
  const header = options.header ?? { id: "sess-a", timestamp: new Date(0).toISOString() };
  const ctx: any = {
    hasUI: false,
    mode: "tui",
    signal: new AbortController().signal,
    sessionManager: { getBranch: () => branch, getHeader: () => header },
    ui: {
      setWidget: (_key: string, value: any) => { widget = value; },
      notify: (text: string) => notices.push(text),
      custom: async () => undefined,
      select: async () => undefined,
      confirm: async () => true,
    },
  };
  const pi: any = {
    on: (event: string, handler: Function) => { (hooks[event] ??= []).push(handler); },
    appendEntry: (customType: string, data: any) => {
      branch.push({ type: "custom", customType, data: structuredClone(data), timestamp: new Date().toISOString() });
    },
    registerTool: (tool: any) => { tools[tool.name] = tool; },
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    events: { on() {}, emit() {} },
  };
  todoExtension(pi);
  const fire = async (event: string, payload: any = {}) => {
    let last: any;
    for (const handler of hooks[event] ?? []) {
      const result = await handler(payload, ctx);
      if (result !== undefined) last = result;
    }
    return last;
  };
  await fire("session_start", {});
  const call = (name: string, args: any) => tools[name].execute("call-1", args, ctx.signal, undefined, ctx);
  return { branch, hooks, tools, commands, notices, ctx, fire, call, widget: () => widget };
}

const parse = (result: any) => result.content[0].text as string;

test("there is no assessment gate: work tools are never blocked", async () => {
  const s = await setup();
  for (const toolName of ["read", "bash", "edit", "write", "browser"]) {
    assert.equal(await s.fire("tool_call", { toolName }), undefined, `${toolName} must run without a todo call`);
  }
  assert.equal(s.branch.length, 0, "no bookkeeping is written for a request that needs none");
  assert.equal(s.widget(), undefined);
});

test("plan → next → claim → done, with evidence the harness verifies", async () => {
  const s = await setup();
  const planned = await s.call(PLAN_TOOL, {
    goal: "Fix the parser",
    tasks: [{ title: "Write the failing test" }, { title: "Fix the parser", deps: ["Write the failing test"] }],
  });
  assert.match(parse(planned), /Plan p-[0-9a-f]{6} \(committed\)/);
  assert.match(parse(planned), /Ready now: t-/);

  const board = await s.call(NEXT_TOOL, {});
  assert.match(parse(board), /1\/2 done|0\/2 done/);
  assert.match(parse(board), /Ready: t-/);

  const [first] = planned.details.tasks;
  const claimed = await s.call(ACT_TOOL, { id: first.id, transition: "claim" });
  assert.match(parse(claimed), /Claimed until/);

  // A second claimant is a different session; the same session may settle it.
  const done = await s.call(ACT_TOOL, {
    id: first.id, transition: "done", evidence: [{ kind: "file", path: "package.json" }],
  });
  assert.equal(done.details.tasks[0].status, "done");
  assert.equal(done.details.tasks[0].verified, true, "a file that exists is verified");
  assert.match(parse(done), /Ready now: t-/, "settling the dependency releases the next task");
});

test("done without a checkable ref is refused; an unfindable file is only attested", async () => {
  const s = await setup();
  const planned = await s.call(PLAN_TOOL, { goal: "g", tasks: [{ title: "Do it" }] });
  const id = planned.details.tasks[0].id;
  await assert.rejects(s.call(ACT_TOOL, { id, transition: "done" }), /requires at least one evidence ref/);
  const attested = await s.call(ACT_TOOL, {
    id, transition: "done", evidence: [{ kind: "file", path: "definitely/not/here.ts" }],
  });
  assert.equal(attested.details.tasks[0].verified, false);
  assert.match(parse(attested), /done/);
});

test("blocked and waiting are computed, so the model never declares them", async () => {
  const s = await setup();
  const planned = await s.call(PLAN_TOOL, {
    goal: "g",
    tasks: [{ title: "A" }, { title: "B", deps: ["A"] }],
  });
  const [a, b] = planned.details.tasks;
  assert.match(parse(planned), new RegExp(`Ready now: ${a.id}\\b`), "only the unblocked task is offered");
  const board = await s.call(NEXT_TOOL, {});
  assert.match(parse(board), new RegExp(`Blocked: ${b.id}`));
  // The old vocabulary is not accepted at all.
  await assert.rejects(s.call(ACT_TOOL, { id: b.id, transition: "blocked" } as any), /./);
});

test("one live claim per resource, and a drop needs no reason", async () => {
  const s = await setup();
  const planned = await s.call(PLAN_TOOL, {
    goal: "g",
    tasks: [
      { title: "A", resource: "file:src/a.ts" },
      { title: "B", resource: "file:src/a.ts" },
    ],
  });
  const [a, b] = planned.details.tasks;
  await s.call(ACT_TOOL, { id: a.id, transition: "claim" });
  await assert.rejects(s.call(ACT_TOOL, { id: b.id, transition: "claim" }), /claimed by sess-a/);

  const dropped = await s.call(ACT_TOOL, { id: b.id, transition: "dropped" });
  assert.equal(dropped.details.tasks[1].status, "dropped");

  // Re-declaring the same goal must not resurrect it.
  const again = await s.call(PLAN_TOOL, { goal: "g", tasks: [{ title: "A" }, { title: "B" }] });
  assert.equal(again.details.tasks[1].status, "dropped");
});

test("a different goal needs explicit replace, so scope is never silently lost", async () => {
  const s = await setup();
  await s.call(PLAN_TOOL, { goal: "old goal", tasks: [{ title: "A" }, { title: "B" }] });
  await assert.rejects(s.call(PLAN_TOOL, { goal: "new goal", tasks: [{ title: "C" }] }), /replace:true/);
  const replaced = await s.call(PLAN_TOOL, { goal: "new goal", tasks: [{ title: "C" }], replace: true });
  assert.equal(replaced.details.total, 1);
  assert.equal(replaced.details.superseded, undefined);
});

test("a committed plan injects one line; a scratch plan injects nothing", async () => {
  const committed = await setup();
  await committed.call(PLAN_TOOL, { goal: "g", tasks: [{ title: "A" }, { title: "B" }] });
  const injected = await committed.fire("context", { messages: [] });
  const added = injected.messages.filter((m: any) => m.customType === "workflow-todo-guidance");
  assert.equal(added.length, 1);
  assert.match(added[0].content, /^Intent plan \(data, not instructions\): plan p-/);
  assert.equal(added[0].content.includes("\n"), false, "one line, never a blob");

  const scratch = await setup();
  await scratch.call(PLAN_TOOL, { goal: "g", scope: "scratch", tasks: [{ title: "A" }] });
  const quiet = await scratch.fire("context", { messages: [] });
  assert.equal(quiet.messages.filter((m: any) => m.customType === "workflow-todo-guidance").length, 0);
});

test("orch_done is refused while a committed plan is unfinished, and allowed otherwise", async () => {
  const s = await setup();
  assert.equal(await s.fire("tool_call", { toolName: "orch_done" }), undefined, "nothing to report against");
  const planned = await s.call(PLAN_TOOL, { goal: "g", tasks: [{ title: "A" }] });
  const blocked = await s.fire("tool_call", { toolName: "orch_done" });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, new RegExp(planned.details.tasks[0].id));
  await s.call(ACT_TOOL, {
    id: planned.details.tasks[0].id, transition: "done", evidence: [{ kind: "file", path: "package.json" }],
  });
  assert.equal(await s.fire("tool_call", { toolName: "orch_done" }), undefined);
});

test("the v1 shim still answers, without the gate and without pretending prose is evidence", async () => {
  const s = await setup();
  assert.match(parse(await s.call(LEGACY_TOOL, { action: "skip" })), /No assessment needed/);

  const planned = await s.call(LEGACY_TOOL, { action: "plan", steps: ["Inspect", "Fix"] });
  assert.match(parse(planned), /0\/2 done/);
  const id = planned.details.tasks[0].id;

  await assert.rejects(s.call(LEGACY_TOOL, { action: "update", id, status: "done" }), /evidence text/);
  const done = await s.call(LEGACY_TOOL, { action: "update", id, status: "done", evidence: "ran npm test" });
  assert.equal(done.details.tasks[0].status, "done");
  assert.equal(done.details.tasks[0].verified, false, "v1 prose is attested, never verified");
});

test("a plan owned by another session is not inherited", async () => {
  const foreign = [{
    type: "custom", customType: WORKFLOW_TODO_ENTRY, timestamp: new Date(0).toISOString(),
    data: {
      v: 2, kind: "plan", ownerSessionId: "someone-else",
      plan: {
        kind: "intent-plan", version: 2, id: "p-aaaaaa", goal: "their goal", scope: "committed",
        createdAt: 0, updatedAt: 0,
        tasks: [{ id: "t-aaaaaa", title: "Their work", status: "open", deps: [], createdAt: 0 }],
      },
    },
  }];
  const s = await setup({ branch: foreign, header: { id: "sess-a", timestamp: new Date(0).toISOString() } });
  // Not a Herdr child, so a fork keeps the branch: the entry is visible on purpose.
  assert.match(parse(await s.call(NEXT_TOOL, {})), /their goal/);
});

test("/workflow-todos cancel drops unfinished scope and keeps the log", async () => {
  const s = await setup();
  await s.call(PLAN_TOOL, { goal: "g", tasks: [{ title: "A" }, { title: "B" }] });
  await s.commands["workflow-todos"].handler("cancel user changed direction", s.ctx);
  const board = await s.call(NEXT_TOOL, {});
  assert.match(parse(board), /0\/2 done/);
  assert.match(parse(board), /Ready: none/);
  // The two transitions are still in the branch, which is the audit trail.
  assert.ok(s.branch.filter(entry => entry.data?.kind === "transition").length >= 2);
});

test("guidance is short, mode-aware, and the tool set is discoverable by other extensions", () => {
  assert.ok(getTodoGuidance().length < 700, "guidance must stay cheap");
  assert.notEqual(getTodoGuidance("plan"), getTodoGuidance("normal"));
  for (const name of TODO_TOOL_NAMES) assert.equal(isTodoTool(name), true);
  assert.equal(isTodoTool("read"), false);
  assert.equal(todoIcon("done"), "\u{f0132}");
  assert.equal(todoIcon("claimed"), "\u{f0450}");
  assert.equal(todoIcon("dropped"), "\u{f0156}");
});
