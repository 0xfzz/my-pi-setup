import test from "node:test";
import assert from "node:assert/strict";
import { meaningfulSessionTitle, sessionTitle, managerName } from "../web/dashboard/src/naming.mjs";
import { DASHBOARD_GOAL_ENTRY, initialPlanTitle, latestGoalTitle, resolveGoalTitle } from "../lib/dashboard/goal-title.ts";
import { projectSession } from "../lib/dashboard/projection.ts";
import { projectGraph, topologySignature, describeNode } from "../web/dashboard/src/graph.mjs";
import { emptyOrchestrator, DASHBOARD_REQUEST_EVENT } from "../lib/dashboard/protocol.ts";
import { publishDashboardMode } from "../lib/dashboard/integration.ts";
import { isSupervisorTool } from "../lib/supervise-mode.ts";
import { isPlanTool } from "../lib/plan-mode.ts";
import dashboardExtension from "../extensions/dashboard.ts";

const record = (title: string, ownerSessionId = "parent") => ({ type: "custom", customType: DASHBOARD_GOAL_ENTRY,
  data: { v: 1, ownerSessionId, title, source: "goal" } });
const plan = (goal: string, ownerSessionId = "parent", scope = "committed") => ({ type: "custom", customType: "workflow-todo:v2",
  data: { v: 2, kind: "plan", ownerSessionId, plan: { goal, scope } } });

test("goal wins over project; titles preserve user casing and Manager is idempotent", () => {
  assert.equal(sessionTitle({ project: "pi-workflow-extensions", sessionName: "Dashboard polish" }), "Dashboard polish");
  assert.equal(managerName({ project: "pi-workflow-extensions", sessionName: "Dashboard polish" }), "Dashboard polish Manager");
  assert.equal(managerName({ sessionName: "Login flow Manager Manager" }), "Login flow Manager");
  assert.equal(sessionTitle({ sessionName: "Old", goalTitle: "New objective" }), "New objective");
  assert.equal(meaningfulSessionTitle("  Fix \n API /login  "), "Fix API /login");
  assert.equal(meaningfulSessionTitle("UI"), "UI");
  assert.ok(meaningfulSessionTitle("Long goal ".repeat(40)).length <= 200);
  assert.ok(meaningfulSessionTitle("Long goal ".repeat(40)).endsWith("…"));
  for (const value of ["", "unknown", "session", "untitled", "123", "cafebabedeadbeef", "child:abc", "</text><script>evil</script>", "/private/path", "aa2e0e1c-1c2b-4d3e-8f90-0123456789ab"]) {
    assert.equal(meaningfulSessionTitle(value), "", value);
  }
  assert.equal(sessionTitle({ project: "pi-workflow-extensions", sessionName: "Pi Workflow Extensions Manager" }), "Pi Workflow Extensions");
});

test("only current owner and branch records count, and clear does not resurrect old plans", () => {
  const branch = [plan("Dashboard polish"), record("Dashboard polish"), record("Child goal", "child"), plan("Verify delegated execution")];
  assert.equal(latestGoalTitle(branch, "parent")?.title, "Dashboard polish");
  assert.equal(resolveGoalTitle({ branch, ownerSessionId: "parent", sessionName: "Stale global name" }), "Dashboard polish");
  assert.equal(resolveGoalTitle({ branch: [record("Login repair")], ownerSessionId: "parent" }), "Login repair");
  assert.equal(resolveGoalTitle({ branch: [...branch, record("")], ownerSessionId: "parent", project: "my-project" }), "My Project");
  assert.equal(initialPlanTitle([plan("Foreign goal", "foreign"), plan("Scratch", "parent", "scratch"), plan("Dashboard polish"), plan("Review implementation")], "parent"), "Dashboard polish");
  assert.equal(initialPlanTitle([{ ...plan("Unknown owner"), data: { ...plan("Unknown owner").data, ownerSessionId: undefined } }], "parent"), "");
});

test("projection ignores file-global Pi name from an abandoned branch", () => {
  const context = { sessionManager: { getSessionId: () => "parent", getSessionName: () => "Other branch goal",
    getEntries: () => [{ type: "session_info", name: "Other branch goal" }], getBranch: () => [record("Dashboard polish")],
    getCwd: () => "/work/pi-workflow-extensions", getLeafId: () => "leaf-a" } };
  assert.equal(projectSession(context, "orchestrator").name, "Dashboard polish");
  context.sessionManager.getBranch = () => [];
  assert.equal(projectSession(context, "orchestrator").name, "Pi Workflow Extensions");
});

test("title changes relayout the same root while detail keeps full title", () => {
  const view = { session: { id: "parent", name: "Dashboard polish", project: "pi-workflow-extensions", mode: "orchestrator" }, orchestrator: emptyOrchestrator(), artifacts: [] };
  const first = projectGraph(view);
  view.session.name = "Login flow repair";
  const next = projectGraph(view);
  assert.equal(first.nodes[0].id, next.nodes[0].id);
  assert.equal(next.nodes[0].label, "Login flow repair Manager");
  assert.notEqual(topologySignature(first), topologySignature(next));
  view.session.name = "Very long approved goal title ".repeat(6).trim();
  const long = projectGraph(view);
  assert.ok(long.nodes[0].label.length <= 40);
  assert.equal(describeNode(long.nodes[0], { artifacts: [] })!.displayName, `${sessionTitle({ sessionName: view.session.name })} Manager`);
});

function harness() {
  let entries: any[] = [];
  let context: any;
  const handlers = new Map<string, Function[]>();
  const subscribers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const snapshots: any[] = [];
  let created = 0;
  const fire = async (name: string, event: any = {}) => {
    for (const fn of handlers.get(name) ?? []) await fn(event, context);
  };
  const pi: any = {
    on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    events: {
      on(name: string, fn: Function) { subscribers.set(name, [...(subscribers.get(name) ?? []), fn]); },
      emit(name: string, data: unknown) { for (const fn of subscribers.get(name) ?? []) fn(data); },
    },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    setSessionName(name: string) { entries.push({ type: "session_info", name }); void fire("session_info_changed", { name }); },
  };
  context = { sessionManager: { getSessionId: () => "parent", getBranch: () => entries, getEntries: () => entries,
    getSessionName: () => [...entries].reverse().find(e => e.type === "session_info")?.name,
    getCwd: () => "/work/pi-workflow-extensions", getHeader: () => ({ id: "parent" }), getLeafId: () => "leaf-a" },
    ui: { notify() {} } };
  dashboardExtension(pi, { coalesceMs: 1, producerFactory: () => { created++; return {
    publish(value: unknown) { snapshots.push(structuredClone(value)); }, close() {},
  }; } });
  return { pi, context, tools, commands, fire, snapshots, setBranch(value: any[]) { entries = value; }, get entries() { return entries; }, get created() { return created; } };
}
async function eventually(predicate: () => boolean) {
  const end = Date.now() + 1000;
  while (!predicate()) {
    assert.ok(Date.now() < end, "timed out waiting for publish");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("goal tool + native rename publish live without new lease; bookkeeping cannot rename", async () => {
  const h = harness();
  await h.fire("session_start");
  publishDashboardMode(h.pi, "orchestrator");
  await eventually(() => h.snapshots.length > 0);
  const goal = (title: string) => h.tools.get("session_goal").execute("call", { title }, undefined, undefined, h.context);
  await goal("Dashboard polish");
  await eventually(() => h.snapshots.at(-1)?.session.name === "Dashboard polish");
  const savedA = [...h.entries];
  h.entries.push(plan("Verify delegated execution"));
  await h.fire("tool_result", { toolName: "todo_plan" });
  await h.fire("tool_result", { toolName: "todo_act" });
  assert.equal(projectSession(h.context, "orchestrator").name, "Dashboard polish");
  await goal("Login flow repair");
  await eventually(() => h.snapshots.at(-1)?.session.name === "Login flow repair");
  assert.equal(h.snapshots.at(-1).session.id, "parent");
  assert.equal(h.created, 1);
  h.pi.setSessionName("Explicit rename");
  await eventually(() => h.snapshots.at(-1)?.session.name === "Explicit rename");
  h.pi.events.emit(DASHBOARD_REQUEST_EVENT, {});
  assert.equal(h.snapshots.at(-1).session.name, "Explicit rename");
  // Branch replay restores its old goal, not Pi's file-global newest name.
  h.setBranch(savedA);
  await h.fire("session_tree");
  await eventually(() => h.snapshots.at(-1)?.session.name === "Dashboard polish");
  await assert.rejects(() => goal("</text><script>evil</script>"), /meaningful/);
  await h.fire("session_shutdown");
});

test("first durable goal seeds once, restores on reload, children cannot publish or rename", async () => {
  const h = harness();
  h.setBranch([plan("Dashboard polish")]);
  await h.fire("session_start");
  assert.equal(latestGoalTitle(h.entries, "parent")?.title, "Dashboard polish");
  h.entries.push(plan("Verify delegated execution"));
  await h.fire("tool_result");
  assert.equal(projectSession(h.context, "normal").name, "Dashboard polish");
  await h.fire("session_shutdown");
  await h.fire("session_start");
  assert.equal(projectSession(h.context, "normal").name, "Dashboard polish");
  await h.fire("session_shutdown");

  const child = harness();
  child.entries.push({ type: "custom", customType: "subagent-context:v1", data: {
    version: 1, mode: "fork", parentSession: "/sessions/parent.jsonl", parentLeafId: "a", parentSessionId: "other",
    seededAt: "2026-10-26T00:00:00.000Z", seededEntries: 0, seededChars: 0, estimatedTokens: 0, truncated: null,
  } });
  await child.fire("session_start");
  publishDashboardMode(child.pi, "orchestrator");
  await assert.rejects(() => child.tools.get("session_goal").execute("x", { title: "Child goal" }, undefined, undefined, child.context), /Only parent/);
  await child.fire("session_info_changed", { name: "Child rename" });
  assert.equal(child.created, 0);
  assert.equal(latestGoalTitle(child.entries, "parent"), undefined);
  await child.fire("session_shutdown");
});

test("session_goal remains callable in Plan and Orchestrator modes", () => {
  assert.ok(isPlanTool("session_goal"));
  assert.ok(isSupervisorTool("session_goal"));
});
