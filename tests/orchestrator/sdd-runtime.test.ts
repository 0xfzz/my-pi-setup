import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import subagentV2, { handoffs, registry, specReviews } from "../../extensions/orchestrator.ts";
import { SUPERVISOR_MODE_TYPE } from "../../lib/supervise-mode.ts";
import { ORCHESTRATOR_WORKFLOW_TYPE } from "../../lib/orchestrator/workflow.ts";
import { PLAN_MODE_TYPE } from "../../lib/plan-mode.ts";

async function harness(options: { workflow?: "sdd" | "general"; plan?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sdd-runtime-"));
  const branch: any[] = [{
    type: "custom",
    customType: SUPERVISOR_MODE_TYPE,
    data: { enabled: true, previousTools: [], modeId: "orchestrator" },
  }];
  if (options.workflow) {
    branch.push({ type: "custom", customType: ORCHESTRATOR_WORKFLOW_TYPE, data: { workflow: options.workflow } });
  }
  if (options.plan) {
    branch.push({ type: "custom", customType: PLAN_MODE_TYPE, data: { enabled: true, previousTools: [] } });
  }

  const tools = new Map<string, any>();
  const hooks = new Map<string, Function[]>();
  const pi: any = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    on(name: string, fn: Function) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
    getAllTools() { return [...tools.values()]; },
    appendEntry() {},
    sendMessage() {},
  };
  const client: any = {
    async paneStart() { return { paneId: "pane" }; },
    async paneRename() {},
    async paneGet(paneId: string) { return { pane_id: paneId }; },
    async paneRead() { return null; },
    async paneList() { return []; },
    async paneClose() {},
    async paneSendText() {},
  };
  subagentV2(pi, { client, stream: { watch: () => () => {}, onReconcile: () => () => {} } });

  const ctx: any = {
    cwd: dir,
    mode: "tui",
    sessionManager: {
      getSessionId: () => "parent-session",
      getSessionFile: () => join(dir, "parent-session.jsonl"),
      getSessionDir: () => dir,
      getBranch: () => branch,
    },
    ui: { notify() {}, async input() { return ""; }, async select() { return ""; }, async confirm() { return false; } },
    async executeTool() {
      return { isError: true, result: { content: [{ type: "text", text: "unused" }] } };
    },
  };

  async function call(params: any) {
    const tool = tools.get("orch_sdd");
    assert.ok(tool, "orch_sdd is registered");
    return tool.execute("call-id", params, undefined, undefined, ctx);
  }

  async function detach() {
    for (const stop of hooks.get("session_shutdown") ?? []) await stop({}, ctx);
    registry.resetForTests();
    handoffs.clear();
    specReviews.clear();
    await rm(dir, { recursive: true, force: true });
  }

  return { dir, branch, call, detach };
}

test("orch_sdd drives the SDD lifecycle in the SDD workflow", async () => {
  const h = await harness({ workflow: "sdd" });
  try {
    const created = await h.call({
      action: "specify",
      feature: "retry-policy",
      title: "Retry policy",
      problem: "Transient failures surface immediately.",
      goals: ["Retry transient failures"],
      requirements: ["Retry transient failures with backoff."],
      acceptance: ["Given a failure, when retried, then it backs off."],
      openQuestions: ["Which statuses are retryable?"],
    });
    assert.equal(created.details.error, undefined, created.content[0].text);
    assert.ok(existsSync(join(h.dir, "specs/retry-policy/spec.md")));

    const draft = await h.call({ action: "status", feature: "retry-policy" });
    assert.match(draft.content[0].text, /Spec status: draft/);

    const blockedPlan = await h.call({ action: "plan", feature: "retry-policy", approach: "A", testStrategy: ["T"] });
    assert.match(blockedPlan.content[0].text, /open questions|draft/i);

    const clarified = await h.call({
      action: "clarify",
      feature: "retry-policy",
      question: "Which statuses are retryable?",
      answer: "429 and 5xx.",
    });
    assert.equal(clarified.details.error, undefined, clarified.content[0].text);

    const plan = await h.call({ action: "plan", feature: "retry-policy", approach: "A", testStrategy: ["T"] });
    assert.equal(plan.details.error, undefined, plan.content[0].text);

    const tasks = await h.call({
      action: "tasks",
      feature: "retry-policy",
      tasks: [{ title: "Add retry", files: ["src/retry.ts"], maps: ["FR-001", "AC-001"], verify: "npm test" }],
    });
    assert.equal(tasks.details.error, undefined, tasks.content[0].text);

    const analyzed = await h.call({ action: "analyze", feature: "retry-policy" });
    assert.match(analyzed.content[0].text, /Clean: no SDD consistency findings/);

    const status = await h.call({ action: "status", feature: "retry-policy" });
    assert.match(status.content[0].text, /Ready: T001/);
    assert.match(status.content[0].text, /Spec reviews: none/);
  } finally {
    await h.detach();
  }
});

test("orch_sdd refuses outside the SDD workflow", async () => {
  const h = await harness({ workflow: "general" });
  try {
    const refused = await h.call({ action: "status", feature: "anything" });
    assert.equal(refused.details.error, "sdd-workflow-required");
    assert.match(refused.content[0].text, /must run \/orch-mode sdd|available only in the SDD workflow/);
  } finally {
    await h.detach();
  }
});

test("orch_sdd is read-only in Plan mode", async () => {
  const h = await harness({ workflow: "sdd", plan: true });
  try {
    const blocked = await h.call({
      action: "specify",
      feature: "retry-policy",
      title: "Retry",
      problem: "P",
      goals: ["G"],
      requirements: ["R"],
      acceptance: ["Given A, when B, then C."],
    });
    assert.equal(blocked.details.error, "plan-read-only");
    assert.equal(existsSync(join(h.dir, "specs/retry-policy/spec.md")), false);
  } finally {
    await h.detach();
  }
});

test("orch_sdd rejects traversal before writing", async () => {
  const h = await harness({ workflow: "sdd" });
  try {
    const refused = await h.call({
      action: "specify",
      feature: "../escape",
      title: "Escape",
      problem: "P",
      goals: ["G"],
      requirements: ["R"],
      acceptance: ["Given A, when B, then C."],
    });
    assert.equal(refused.details.error, "sdd-error");
    assert.match(refused.content[0].text, /Invalid feature/);
    assert.equal(existsSync(join(h.dir, "escape")), false);
  } finally {
    await h.detach();
  }
});
