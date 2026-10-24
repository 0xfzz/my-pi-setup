import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import todo from "../extensions/todo.ts";
import { replay } from "../lib/intent-graph.ts";
import askUser from "../extensions/ask-user.ts";
import checkpoints from "../extensions/subagent-checkpoints.ts";

const orders = [
  [todo, askUser, checkpoints], [todo, checkpoints, askUser],
  [askUser, todo, checkpoints], [askUser, checkpoints, todo],
  [checkpoints, todo, askUser], [checkpoints, askUser, todo],
];

/** A prompt that genuinely needs an assessment decision, unlike a greeting. */
const WORK = "Fix the flaky login test";

/** Assistant reply for provider call N (1-based). */
type Script = (call: number) => { content: any[]; stopReason: "stop" | "toolUse" };

// Real Pi runtime, scripted in-process provider. No credentials, HTTP, or inference.
async function fixture(factories: ((pi: any) => void)[], script: Script) {
  const dir = await mkdtemp(join(tmpdir(), "pi-workflow-test-"));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  let calls = 0;
  let agentEnds = 0;
  const errors: unknown[] = [];
  const model = {
    id: "workflow-local-test", name: "Workflow local test", provider: "workflow-test", api: "workflow-scripted",
    baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"] as ("text")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
  };
  const streamed = () => {
    calls++;
    const { content, stopReason } = script(calls);
    const stream = createAssistantMessageEventStream();
    const message: any = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content, stopReason,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: stopReason, message });
    return stream;
  };
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [...factories, pi => {
      pi.registerProvider("workflow-test", {
        api: model.api, baseUrl: model.baseUrl, apiKey: "local-scripted-test-not-a-secret", models: [model], streamSimple: streamed,
      });
      pi.on("agent_end", () => { agentEnds++; });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings,
    sessionManager: SessionManager.inMemory(dir), model,
  });
  await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
  return {
    session, errors,
    calls: () => calls,
    agentEnds: () => agentEnds,
    branch: () => session.sessionManager.getBranch(),
    todoState: () => replay(session.sessionManager.getBranch()
      .filter((e: any) => e.type === "custom" && e.customType === "workflow-todo:v2")
      .map((e: any) => e.data)),
    dispose: async () => { session.dispose(); await rm(dir, { recursive: true, force: true }); },
  };
}

// v2 contract: declaring a plan claims nothing, so a premature stop is NOT
// nudged. The old gate-driven continuation was the source of the admin loop.
for (const factories of orders) test(`real Pi composes all workflow extensions: ${factories.map(f => f.name).join(", ")}`, async () => {
  const f = await fixture(factories, call => call === 1
    ? { content: [{ type: "toolCall", id: "plan-1", name: "todo_plan", arguments: {
      goal: WORK,
      tasks: [{ title: "Inspect failure" }, { title: "Verify fix", deps: ["Inspect failure"] }],
    } }], stopReason: "toolUse" }
    : { content: [{ type: "text", text: "Premature response" }], stopReason: "stop" });
  try {
    await f.session.prompt(WORK);
    assert.equal(f.calls(), 2, "plan -> premature stop: nothing was claimed, so nothing forces work");
    assert.equal(f.agentEnds(), 1);
    assert.deepEqual(f.errors, []);
    const plan = f.todoState()!;
    assert.equal(plan.tasks.length, 2);
    assert.deepEqual(plan.tasks.map((item: any) => item.status), ["open", "open"]);
  } finally {
    await f.dispose();
  }
});

// A live CLAIM is the one thing that earns a nudge: the agent said it was doing
// the work and stopped. Exactly one reminder per claim, then the claim settles.
for (const factories of orders) test(`real Pi nudges once for a claimed task: ${factories.map(f => f.name).join(", ")}`, async () => {
  const f = await fixture(factories, call => call === 1
    ? { content: [{ type: "toolCall", id: "plan-1", name: "todo_plan", arguments: {
      goal: WORK, tasks: [{ title: "Inspect failure" }],
    } }], stopReason: "toolUse" }
    : call === 2
      ? { content: [{ type: "toolCall", id: "claim-1", name: "workflow_todo", arguments: { action: "update", id: 1, status: "in_progress" } }], stopReason: "toolUse" }
      : call === 3
        ? { content: [{ type: "text", text: "Stopping without finishing." }], stopReason: "stop" }
        : call === 4
          ? { content: [{ type: "toolCall", id: "done-1", name: "workflow_todo", arguments: { action: "update", id: 1, status: "done", evidence: "Scripted inspection" } }], stopReason: "toolUse" }
          : { content: [{ type: "text", text: "Finished." }], stopReason: "stop" });
  try {
    await f.session.prompt(WORK);
    assert.equal(f.calls(), 5, "plan -> claim -> stop -> one reminder -> settle -> answer");
    assert.equal(f.agentEnds(), 1, "the continuation precedes Herdr's agent_end auto-exit");
    assert.deepEqual(f.errors, []);
    const plan = f.todoState()!;
    assert.deepEqual(plan.tasks.map((item: any) => item.status), ["done"]);
    assert.equal(plan.tasks[0].verified, false, "v1 prose evidence is attested, never verified");
  } finally {
    await f.dispose();
  }
});

// Regression: session 01a168fc (2026-10-23). The prompt "test" was answered, then the
// unassessed reminder forced a continuation whose wording ("skip, plan, or continue")
// implied a task existed. The model went looking for one — workflow_todo{},
// artifact_list, vcc_recall and a git probe were fired or blocked, then `continue` was
// rejected ("No existing plan"), then `skip` was rejected for a missing reason.
// The guard must not manufacture work, regardless of language or exact wording.
for (const prompt of ["test", "hi", "bonjour", "terima kasih", "Explain what a closure is"]) {
  test(`real Pi: text-only reply to ${JSON.stringify(prompt)} needs no assessment round-trip`, async () => {
    const f = await fixture([todo, askUser, checkpoints], () =>
      ({ content: [{ type: "text", text: "Loud and clear! How can I help you today?" }], stopReason: "stop" }));
    try {
      await f.session.prompt(prompt);
      assert.equal(f.calls(), 1, "a text-only reply must finish in a single provider call");
      assert.equal(f.agentEnds(), 1);
      assert.deepEqual(f.errors, []);
      assert.equal(f.todoState(), undefined, "no todo state is persisted for a prompt that needs no list");
    } finally {
      await f.dispose();
    }
  });
}

test("real Pi: a text-only reply does not leave anything for the NEXT work request to unlock", async () => {
  const f = await fixture([todo, askUser, checkpoints], call => call === 1
    ? { content: [{ type: "text", text: "Loud and clear!" }], stopReason: "stop" }
    : call === 2
      ? { content: [{ type: "toolCall", id: "work-1", name: "bash", arguments: { command: "true" } }], stopReason: "toolUse" }
      : { content: [{ type: "text", text: "Done." }], stopReason: "stop" });
  try {
    await f.session.prompt("hi");
    assert.equal(f.calls(), 1);
    await f.session.prompt(WORK);
    assert.equal(f.calls(), 3, "work runs immediately: no blocked attempt, no skip call");
    const results = f.branch().filter(entry => entry.type === "message")
      .map(entry => entry.message).filter(message => message.role === "toolResult");
    assert.equal(results.length, 1);
    assert.equal(results[0].toolName, "bash");
    assert.equal(results[0].isError, false, "the work tool actually ran");
    assert.equal(f.todoState(), undefined, "no plan, so no bookkeeping");
    assert.deepEqual(f.errors, []);
  } finally {
    await f.dispose();
  }
});