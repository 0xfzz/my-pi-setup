import test from "node:test";
import assert from "node:assert/strict";
import modes from "../extensions/modes.ts";
import artifacts from "../extensions/artifacts.ts";
import { ARTIFACT_TYPE } from "../lib/artifact-state.ts";
import { INPUT_MODE_CONTEXT_TYPE, PLAN_MODE_GUIDANCE, PLAN_MODE_TYPE, inputModeGuidance, isPlanTool as planToolPolicy, planModeFromBranch } from "../lib/plan-mode.ts";
import { createArtifactAutocompleteProvider } from "../lib/artifact-mentions.ts";

const isPlanTool = (name: string) => planToolPolicy(name);
const artifact = { id: "design", title: "Design", type: "spec", content: "Existing proposal", version: 1,
  createdBy: "main", createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z", tags: [] };
function fixture(branch: any[] = [], order = [modes, artifacts]) {
  const hooks = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const notices: string[] = [];
  let active = ["read", "bash", "codemode", "artifact_save", "artifact_recall", "artifact_list", "ask_user", "workflow_todo"];
  let idle = true;
  let editorFactory: any;
  let widgetFactory: any;
  let autocompleteFactory: any;
  const pi: any = {
    on(name: string, fn: Function) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    appendEntry(customType: string, data: any) { branch.push({ type: "custom", customType, data }); },
    getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = [...names]; },
    getAllTools: () => [...new Set([...active, ...tools.keys(), "late_browser"])].map(name => ({ name })),
  };
  const ctx: any = { mode: "tui", hasUI: true, isIdle: () => idle,
    sessionManager: { getBranch: () => branch }, ui: {
      notify(text: string) { notices.push(text); }, setWidget(_key: string, factory: any) { widgetFactory = factory; },
      setEditorComponent(factory: any) { editorFactory = factory; }, addAutocompleteProvider(factory: any) { autocompleteFactory = factory; },
    } };
  for (const factory of order) factory(pi);
  const emit = async (name: string, event: any = {}) => {
    const results = [];
    for (const hook of hooks.get(name) ?? []) results.push(await hook(event, ctx));
    return results.filter(Boolean);
  };
  return { branch, ctx, pi, notices, commands, tools, emit,
    active: () => active, setIdle(value: boolean) { idle = value; },
    editor: () => editorFactory, widget: () => widgetFactory, autocomplete: () => autocompleteFactory,
    command: (args = "mode") => commands.get("plan").handler(args, ctx),
    call: (name: string, args: any) => tools.get(name).execute("test", args, undefined, undefined, ctx),
  };
}

for (const order of [[modes, artifacts], [artifacts, modes]]) {
  test(`plan mode permits read-only exploration and artifact creation/updates, order ${order[0]!.name}`, async () => {
    const f = fixture([{ type: "custom", customType: ARTIFACT_TYPE, data: artifact }], order);
    await f.emit("session_start");
    const original = [...f.active()];
    await f.command();
    assert.ok(f.active().every(isPlanTool));
    assert.ok(f.active().includes("artifact_save"));
    assert.ok(f.active().includes("ask_user"));
    await f.command("on"); // Idempotent: don't replace the original loadout with the restricted one.
    assert.deepEqual(planModeFromBranch(f.branch)?.previousTools, original);
    const event = { systemPromptOptions: { selectedTools: original, sections: { existing: "Keep me" } } };
    await f.emit("before_agent_start", event);
    assert.equal(event.systemPromptOptions.sections.existing, "Keep me");
    assert.match((event.systemPromptOptions.sections as any).plan_mode, /Challenge assumptions/);
    assert.ok(event.systemPromptOptions.selectedTools.every(isPlanTool));
    for (const toolName of ["write", "edit", "powershell", "browser", "mcp", "codemode", "late_browser", "artifact_save_fake"]) {
      const result = await f.emit("tool_call", { toolName, parentToolCallId: "nested", input: {} });
      assert.equal(result[0].block, true, toolName);
    }
    for (const toolName of ["read", "ffgrep", "fffind", "google_search", "artifact_save", "artifact_list", "artifact_recall", "ask_user", "workflow_todo"]) {
      assert.deepEqual(await f.emit("tool_call", { toolName, input: {} }), []);
    }
    assert.match((await f.emit("user_bash", { command: "touch forbidden" }))[0].result.output, /blocks shell/);
    await f.call("artifact_save", { id: "Design", title: "Design", type: "spec", content: "Refined proposal" });
    const recalled = await f.call("artifact_recall", { id: "design" });
    assert.equal(recalled.details.version, 2);
    assert.match(recalled.content[0].text, /Refined proposal/);
    await f.call("artifact_save", { id: "new", title: "New", type: "plan", content: "Allowed in Plan" });
    assert.equal((await f.call("artifact_list", {})).details.count, 2);
    assert.deepEqual(await f.emit("tool_call", { toolName: "write", input: { path: "artifacts/fake.md", content: "blocked" } }), [{ block: true, reason: "Plan mode: write is blocked. Read-only inspection is allowed; writes are only allowed through artifact_save. Use /plan off to implement changes." }]);
    await f.command("off");
    assert.deepEqual(f.active(), original);
    assert.equal(planModeFromBranch(f.branch)?.enabled, false);
    assert.deepEqual(await f.emit("tool_call", { toolName: "bash" }), []);
    assert.deepEqual(await f.emit("user_bash", {}), []);
    await f.call("artifact_save", { id: "new", title: "New", type: "plan", content: "Now allowed" });
    await f.emit("session_shutdown");
  });
}

test("plan persists on reload/non-TUI startup, follows branches and restores original tools", async () => {
  const f = fixture();
  f.ctx.mode = "rpc";
  await f.emit("session_start");
  const original = [...f.active()];
  await f.command("");
  const saved = [...f.branch];
  await f.emit("session_shutdown");
  const reloaded = fixture([...saved]);
  reloaded.ctx.mode = "print";
  await reloaded.emit("session_start");
  assert.ok(reloaded.active().every(isPlanTool));
  await reloaded.command("status");
  assert.match(reloaded.notices.at(-1)!, /read-only exploration/);
  reloaded.branch.length = 0;
  // Real Pi restores the destination transcript before the extension tree hook.
  reloaded.pi.setActiveTools(original);
  await reloaded.emit("session_tree");
  assert.deepEqual(reloaded.active(), original);
  reloaded.branch.push(...saved);
  await reloaded.emit("session_tree");
  assert.ok(reloaded.active().every(isPlanTool));
  await reloaded.command("off");
  assert.deepEqual(reloaded.active(), original);
  assert.equal(planModeFromBranch(reloaded.branch)?.enabled, false);
  await reloaded.emit("session_shutdown");
});

test("busy transitions and running/unverified children cannot enter Plan; busy Plan cannot exit", async () => {
  const f = fixture();
  await f.emit("session_start");
  const original = [...f.active()];
  f.setIdle(false);
  await f.command();
  assert.deepEqual(f.active(), original);
  assert.match(f.notices.at(-1)!, /Stop the current turn/);
  f.setIdle(true);
  f.branch.push({ type: "custom", customType: "subagent-checkpoint:v1", data: { sessionFile: "child", name: "Child", status: "running", ended: false } });
  await f.command();
  assert.match(f.notices.at(-1)!, /running\/unverified children/);
  assert.equal(planModeFromBranch(f.branch), undefined);
  f.branch.length = 0;
  await f.command();
  f.setIdle(false);
  await f.commands.get("mode").handler("normal", f.ctx);
  assert.equal(planModeFromBranch(f.branch)?.enabled, true);
  await f.command("off");
  assert.equal(planModeFromBranch(f.branch)?.enabled, true);
  f.setIdle(true);
  await f.commands.get("mode").handler("normal", f.ctx);
  assert.equal(planModeFromBranch(f.branch)?.enabled, false);
  assert.deepEqual(f.active(), original);
  await f.commands.get("mode").handler("bash", f.ctx);
  assert.match(f.notices.at(-1)!, /Unknown mode/);
  assert.equal(planModeFromBranch(f.branch)?.enabled, false);
  await f.command("bad");
  assert.match(f.notices.at(-1)!, /Usage/);
  assert.deepEqual(f.commands.get("plan").getArgumentCompletions("mo"), [{ value: "mode", label: "mode" }]);
});

test("Shift+Tab enters/exits Plan through enforced transitions and preserves draft", async () => {
  const f = fixture();
  await f.emit("session_start");
  const color = (text: string) => text;
  const editor = f.editor()({ requestRender() {}, terminal: { rows: 30, columns: 80 } }, {
    borderColor: color, selectList: { selectedPrefix: color, selectedText: color, description: color, scrollInfo: color, noMatch: color },
  }, { matches: () => false });
  editor.setText("Keep the draft");
  editor.handleInput("\x1b[Z"); // Normal -> Plan.
  assert.equal(planModeFromBranch(f.branch)?.enabled, true);
  assert.equal(editor.getText(), "Keep the draft");
  const widget = f.widget()({}, { fg: (_token: string, text: string) => text, bold: color });
  assert.match(widget.render(100).join("\n"), /\[ 󰏫 Plan \]/u);
  const submissions: string[] = [];
  editor.onSubmit = (text: string) => submissions.push(text);
  editor.onSubmit("Brainstorm");
  assert.deepEqual(submissions, ["Brainstorm"]);
  f.setIdle(false);
  editor.handleInput("\x1b[Z");
  assert.equal(planModeFromBranch(f.branch)?.enabled, true);
  f.setIdle(true);
  editor.handleInput("\x1b[Z");
  assert.equal(planModeFromBranch(f.branch)?.enabled, false);
  editor.setText("");
});

test("Plan accepts file/skill/image input and validates native shell inspection separately", async () => {
  const f = fixture();
  await f.emit("session_start");
  await f.command();
  for (const text of ["/skill:secret", "!cat secret", "/template", "/help", "/artifacts", "Review @artifact:missing"]) {
    assert.ok(!(await f.emit("input", { text })).some(result => result.action === "handled"));
  }
  assert.ok(!(await f.emit("input", { text: "image", images: [{ type: "image" }] })).some(r => r.action === "handled"));
  const native = await f.emit("user_bash", { command: "cat secret" });
  assert.equal(typeof native[0].operations.exec, "function");
  assert.equal((await f.emit("user_bash", { command: "touch forbidden" }))[0].result.exitCode, 1);
  // Pi 1.3 applies bash hardening through in-place mutation of `event.input`;
  // `ToolCallEventResult` carries no `input` field. Assert the mutation the
  // agent loop actually observes, not a returned patch it would discard.
  const inspected: any = { toolName: "bash", input: { command: "cat secret | head -n 2", timeout: 4 } };
  assert.deepEqual(await f.emit("tool_call", inspected), [], "a read-only command is not blocked");
  assert.equal(inspected.input.command, "'cat' 'secret' | 'head' '-n' '2'");
  assert.equal(inspected.input.timeout, 4);
  assert.equal((await f.emit("tool_call", { toolName: "bash", input: { command: "cat secret > artifacts.md" } }))[0].block, true);
});

test("artifact-only completions never invoke file providers, including forced path completion and stale items", async () => {
  let restricted = true;
  let nativeCalls = 0;
  const native: any = { triggerCharacters: ["@"],
    async getSuggestions() { nativeCalls++; return { prefix: "@", items: [{ value: "@file.ts" }] }; },
    shouldTriggerFileCompletion() { nativeCalls++; return true; },
    applyCompletion() { nativeCalls++; return {}; },
  };
  const provider = createArtifactAutocompleteProvider(native, () => new Map([[artifact.id, artifact as any]]), () => restricted);
  for (const text of ["@", "@artifact", "@design", "./", "@src/file", "/skill:secret", "plain text"]) {
    const result = await provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal, force: true } as any);
    if (["@", "@artifact", "@design"].includes(text)) assert.equal(result?.items[0].value, "@artifact:design");
    else assert.equal(result, null);
    provider.shouldTriggerFileCompletion?.([text], 0, text.length);
  }
  assert.deepEqual(provider.applyCompletion(["@"], 0, 1, { value: "@file.ts", label: "@file.ts" }, "@"), { lines: ["@"], cursorLine: 0, cursorCol: 1 });
  assert.equal(nativeCalls, 0);
  restricted = false;
  await provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal } as any);
  assert.equal(nativeCalls, 1);
});

test("every AI run gets current-mode guidance and Normal clears stale Plan instructions", async () => {
  const f = fixture();
  await f.emit("session_start");
  const original = [...f.active()];
  for (const mode of ["normal", "plan", "normal"]) {
    await f.commands.get("mode").handler(mode, f.ctx);
    const event = { systemPromptOptions: { selectedTools: [...f.active()], sections: {
      existing: "Keep another extension's section", plan_mode: PLAN_MODE_GUIDANCE, input_mode: "Old mode",
    } as Record<string, string> } };
    await f.emit("before_agent_start", event);
    const sections = event.systemPromptOptions.sections;
    assert.equal(sections.existing, "Keep another extension's section");
    assert.match(sections.input_mode!, new RegExp(`Current input mode: ${mode[0]!.toUpperCase()}${mode.slice(1)}`));
    if (mode === "plan") {
      assert.match(sections.input_mode!, /Plan mode is ON/);
      assert.equal(sections.plan_mode, PLAN_MODE_GUIDANCE);
      assert.ok(event.systemPromptOptions.selectedTools.every(isPlanTool));
    } else {
      assert.match(sections.input_mode!, /Plan mode is OFF/);
      assert.match(sections.input_mode!, /historical, not the current policy/);
      assert.equal(sections.plan_mode, undefined);
      assert.deepEqual(event.systemPromptOptions.selectedTools, original);
    }
  }
});

test("before-agent briefing reconciles a missed branch refresh with UI, tools and policy", async () => {
  const f = fixture();
  await f.emit("session_start");
  const original = [...f.active()];
  for (const enabled of [true, false]) {
    f.branch.push({ type: "custom", customType: PLAN_MODE_TYPE, data: { enabled, previousTools: original } });
    const selectedBefore = [...f.active()];
    const event = { systemPromptOptions: { selectedTools: selectedBefore, sections: {} as Record<string, string> } };
    await f.emit("before_agent_start", event); // Intentionally no session_tree notification.
    const label = enabled ? "Plan" : "Normal";
    assert.match(event.systemPromptOptions.sections.input_mode!, new RegExp(`Current input mode: ${label}`));
    assert.match(f.widget()({}, { fg: (_token: string, text: string) => text, bold: (text: string) => text }).render(120).join("\n"), new RegExp(`\\[ . ${label} \\]`, "u"));
    if (enabled) {
      assert.ok(f.active().every(isPlanTool));
      assert.ok(event.systemPromptOptions.selectedTools.every(isPlanTool));
      assert.equal((await f.emit("tool_call", { toolName: "bash" }))[0].block, true);
    } else {
      assert.deepEqual(f.active(), original);
      // Pi's real hook runner falls back to active tools unless another hook
      // explicitly edits this field. Normal must preserve that upstream choice.
      assert.equal(event.systemPromptOptions.selectedTools, selectedBefore);
      assert.deepEqual(await f.emit("tool_call", { toolName: "bash" }), []);
    }
  }
});

test("request-local mode reminder supersedes stale Plan history without persisting or duplicating", async () => {
  const f = fixture();
  await f.emit("session_start");
  await f.command("on");
  const oldHistory = [
    { role: "compactionSummary", summary: "Plan mode is active; only artifacts may be written.", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "You must run /plan off first." }], timestamp: 2 },
    { role: "custom", customType: INPUT_MODE_CONTEXT_TYPE, content: "Stale Plan reminder", display: false, timestamp: 3 },
    { role: "user", content: "Implement it now", timestamp: 4 },
  ];
  const originalHistory = structuredClone(oldHistory);
  const plan = (await f.emit("context", { messages: oldHistory }))[0].messages;
  assert.match(plan.at(-1).content, /Current input mode: Plan/);
  assert.match(plan.at(-1).content, /Plan mode is ON/);
  await f.command("off");
  const branchLength = f.branch.length;
  let messages = plan;
  for (let i = 0; i < 5; i++) {
    messages = (await f.emit("context", { messages }))[0].messages;
    assert.equal(messages.filter((m: any) => m.customType === INPUT_MODE_CONTEXT_TYPE).length, 1);
    assert.equal(messages.at(-1).customType, INPUT_MODE_CONTEXT_TYPE);
    assert.match(messages.at(-1).content, /Current input mode: Normal/);
    assert.match(messages.at(-1).content, /Plan mode is OFF/);
    assert.match(messages.at(-1).content, /Do not ask the user to run \/plan off again/);
    assert.equal(messages.length, oldHistory.length);
  }
  assert.deepEqual(oldHistory, originalHistory, "historical messages must not be rewritten");
  assert.equal(f.branch.length, branchLength, "context reminders must not grow persisted history");
  // Restore must also work at request time when a tree notification was missed.
  f.branch.push({ type: "custom", customType: PLAN_MODE_TYPE, data: { enabled: true, previousTools: [] } });
  const restored = (await f.emit("context", { messages }))[0].messages;
  assert.match(restored.at(-1).content, /Plan mode is ON/);
  assert.ok(f.active().every(isPlanTool));
});

test("automatic Plan briefing explains the discussion workflow without granting implementation", () => {
  for (const phase of ["1. Clarify", "2. Recall existing artifacts", "3. Grill the idea", "4. Compare", "5. Create or refine artifacts", "6. Summarize"]) {
    assert.ok(PLAN_MODE_GUIDANCE.includes(phase), phase);
  }
  for (const phrase of ["one at a time", "suggestions are not approval", "Stop before implementation", "Only the user can leave", "When input_mode says Plan is OFF"]) {
    assert.ok(PLAN_MODE_GUIDANCE.includes(phrase), phrase);
  }
  assert.match(inputModeGuidance({ id: "normal", label: "Normal" }), /Normal mode supports regular AI chat/);
});

test("native shell submit promises prevent Plan entry without replacing other shell extensions", async () => {
  const f = fixture();
  await f.emit("session_start");
  const color = (text: string) => text;
  const editor = f.editor()({ requestRender() {}, terminal: { rows: 30, columns: 80 } }, {
    borderColor: color, selectList: { selectedPrefix: color, selectedText: color, description: color, scrollInfo: color, noMatch: color },
  }, { matches: () => false });
  editor.setText("Preserve draft");
  for (const fail of [false, true]) {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    editor.onSubmit = async (text: string) => { assert.match(text, /^!/); await gate; if (fail) throw new Error("shell failed"); };
    const submitted = editor.onSubmit("!echo test");
    // isIdle is still true: it reports agent state, not this native shell.
    assert.deepEqual(await f.emit("user_bash", {}), [], "do not steal other extensions' user_bash operations");
    await f.command("on");
    assert.notEqual(planModeFromBranch(f.branch)?.enabled, true);
    assert.match(f.notices.at(-1)!, /shell command/);
    editor.handleInput("\x1b[Z"); // Normal -> Plan must still be rejected.
    assert.notEqual(planModeFromBranch(f.branch)?.enabled, true);
    assert.equal(editor.getText(), "Preserve draft");
    finish();
    if (fail) await assert.rejects(submitted, /shell failed/); else await submitted;
    await f.command("on");
    assert.equal(planModeFromBranch(f.branch)?.enabled, true);
    await f.command("off");
  }
  // Synchronous exceptions must also release the counter.
  editor.onSubmit = () => { throw new Error("synchronous failure"); };
  assert.throws(() => editor.onSubmit("!!echo test"), /synchronous failure/);
  await f.command("on");
  assert.equal(planModeFromBranch(f.branch)?.enabled, true);
  editor.setText("");
});

test("slash commands reconcile missed same-boolean branch changes before exiting Plan", async () => {
  const f = fixture();
  await f.emit("session_start");
  const original = [...f.active()];
  f.branch.push({ type: "custom", customType: PLAN_MODE_TYPE, data: { enabled: true, previousTools: original } });
  await f.command("off"); // No tree notification or agent request before the user command.
  assert.equal(planModeFromBranch(f.branch)?.enabled, false);
  assert.deepEqual(f.active(), original);
});

test("Plan artifact extension retains native file, path and skill completions", async () => {
  const f = fixture();
  await f.emit("session_start");
  await f.command();
  const calls: string[] = [];
  const native: any = { triggerCharacters: ["@"],
    async getSuggestions(lines: string[]) { calls.push(lines[0]!); return { prefix: lines[0], items: [{ value: "@file.ts", label: "@file.ts" }] }; },
    applyCompletion() { return { lines: ["@file.ts "], cursorLine: 0, cursorCol: 9 }; },
  };
  const provider = f.autocomplete()(native);
  for (const text of ["@src", "./", "/skill:example"]) {
    const result = await provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal, force: true });
    assert.equal(result.items[0].value, "@file.ts");
  }
  assert.deepEqual(calls, ["@src", "./", "/skill:example"]);
  assert.equal(provider.applyCompletion(["@src"], 0, 4, { value: "@file.ts", label: "@file.ts" }, "@src").lines[0], "@file.ts ");
});

test("plan-state parser uses last active-branch record only and ignores malformed data", () => {
  assert.equal(planModeFromBranch(undefined), undefined);
  assert.equal(planModeFromBranch([{ type: "custom", customType: PLAN_MODE_TYPE, data: {} }]), undefined);
  assert.deepEqual(planModeFromBranch([
    { type: "custom", customType: PLAN_MODE_TYPE, data: { enabled: true, previousTools: ["bash", 42] } },
  ]), { enabled: true, previousTools: ["bash"] });
});
