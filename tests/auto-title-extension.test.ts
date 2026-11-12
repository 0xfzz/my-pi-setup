import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import autoTitleExtension from "../extensions/auto-title.ts";
import {
  AUTO_TITLE_PLUGIN_ID,
  AUTO_TITLE_REGENERATE_ACTION,
  AUTO_TITLE_TOGGLE_ACTION,
  autoTitleWebView,
} from "../lib/auto-title-web-view.ts";
import { TITLE_ATTEMPT_ENTRY, TITLE_RECORD_ENTRY } from "../lib/title/provenance.ts";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT } from "../lib/web-plugins/actions.ts";
import { validatePlugin } from "../lib/web-plugins/descriptor.ts";
import { validateRegistry } from "../lib/web-plugins/registry.ts";
import { WEB_PLUGIN_VIEW_EVENT, validateView } from "../lib/web-plugins/view.ts";
import { WEB_PLUGINS } from "../web/plugins/index.ts";
import { autoTitlePlugin } from "../web/plugins/auto-title.ts";

const exchange = [
  { type: "message", message: { role: "user", content: "fix the login bug" } },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Found it in auth.ts" }] } },
];

const replyText = (text: string) => async () => ({ stopReason: "stop", content: [{ type: "text", text }] });

function harness(opts: { name?: string; branch?: any[]; reply?: () => Promise<any>; stateFile?: string } = {}) {
  const stateFile = opts.stateFile ?? join(mkdtempSync(join(tmpdir(), "auto-title-state-")), "auto-title.json");
  let name = opts.name;
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  const views: any[] = [];
  const notices: string[] = [];
  const requests: any[] = [];
  const commands = new Map<string, any>();
  const written: any[] = [];
  const pi: any = {
    on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerCommand: (command: string, spec: unknown) => commands.set(command, spec),
    appendEntry: (customType: string, data: unknown) => written.push({ type: "custom", customType, data }),
    getSessionName: () => name,
    setSessionName: (value: string) => { name = value; },
    events: {
      on: (channel: string, handler: any) => eventHandlers.set(channel, [...(eventHandlers.get(channel) ?? []), handler]),
      emit: (channel: string, data: any) => {
        if (channel === WEB_PLUGIN_VIEW_EVENT) views.push(data.view);
      },
    },
  };
  const ctx: any = {
    cwd: "/work/my-project",
    model: { provider: "p", id: "m" },
    ui: { notify: (message: string) => notices.push(message) },
    sessionManager: {
      getSessionId: () => "s1",
      getBranch: () => [...(opts.branch ?? exchange), ...written],
      getHeader: () => undefined,
      getSessionFile: () => undefined,
    },
    modelRegistry: {
      streamSimple: (model: unknown, context: any, options: any) => {
        requests.push({ model, context, options });
        const pending = opts.reply
          ? opts.reply()
          : Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: '"Fix Login Bug."' }] });
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "done", message: await pending };
          },
        };
      },
    },
  };
  autoTitleExtension(pi, { stateFile });
  const emit = async (event: string) => {
    for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
    await new Promise((resolve) => setImmediate(resolve));
  };
  const action = async (actionId: string) => {
    for (const handler of eventHandlers.get(WEB_PLUGIN_ACTION_REQUEST_EVENT) ?? []) {
      handler({ pluginId: AUTO_TITLE_PLUGIN_ID, actionId });
    }
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { ctx, emit, action, views, notices, requests, commands, written, stateFile, name: () => name, rename: (value: string) => { name = value; } };
}

const committedPlan = {
  type: "custom",
  customType: "workflow-todo:v2",
  data: { v: 2, ownerSessionId: "s1", kind: "plan", plan: { scope: "committed", goal: "Build the export feature" } },
};

test("an untitled session is named once, from the first exchange, on the current model", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.emit("agent_end");
  assert.equal(h.name(), "Fix Login Bug");
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].model, h.ctx.model);
  assert.equal(h.requests[0].options.maxTokens, 64);
  assert.equal(h.requests[0].options.cacheRetention, "none", "a one-off title request must not be treated as an agent turn");
  assert.equal(h.requests[0].options.maxRetries, 0);
  assert.equal(h.requests[0].options.reasoning, undefined, "thinking is off for a model that allows it");
  assert.match(h.requests[0].context.messages[0].content, /<first_user>fix the login bug<\/first_user>/);
  assert.match(h.requests[0].context.messages[0].content, /<first_assistant>Found it in auth\.ts<\/first_assistant>/);
  await h.emit("agent_end");
  assert.equal(h.requests.length, 1, "a titled session with no refinement signal is not titled again");
});

test("a generated title is recorded on the branch before it is applied", async () => {
  const h = harness();
  await h.emit("agent_end");
  assert.equal(h.name(), "Fix Login Bug");
  assert.equal(h.written.length, 1);
  assert.equal(h.written[0].customType, TITLE_RECORD_ENTRY);
  assert.deepEqual(h.written[0].data, {
    v: 1,
    ownerSessionId: "s1",
    title: "Fix Login Bug",
    source: "auto",
    generation: 1,
    model: "p/m",
  });
});

test("an existing name is never replaced by the automatic path", async () => {
  const h = harness({ name: "My own name" });
  await h.emit("agent_end");
  assert.equal(h.requests.length, 0);
  assert.equal(h.name(), "My own name");
});

test("a name a person sets after the provisional title locks the automatic path", async () => {
  const h = harness({ branch: [...exchange, committedPlan] });
  await h.emit("agent_end");
  assert.equal(h.name(), "Fix Login Bug");
  h.rename("Mine");
  await h.emit("agent_end");
  assert.equal(h.requests.length, 1, "no refinement once a person has named it");
  assert.equal(h.name(), "Mine");
});

test("a name set while the request is in flight wins", async () => {
  let release: (value: unknown) => void = () => {};
  const h = harness({ reply: () => new Promise((resolve) => { release = resolve; }) });
  const pending = h.emit("agent_end");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.requests.length, 1, "the request is parked on the model");
  h.rename("Typed by the user");
  release({ stopReason: "stop", content: [{ type: "text", text: "Generated Title Here" }] });
  await pending;
  assert.equal(h.name(), "Typed by the user");
  assert.equal(h.written.at(-1).customType, TITLE_ATTEMPT_ENTRY, "the discarded result is recorded as superseded");
  assert.equal(h.written.at(-1).data.outcome, "superseded");
});

test("a refinement runs once, and a KEEP answer writes no name but spends the pass", async () => {
  const answers = ["Fix Login Bug", "KEEP"];
  const h = harness({
    branch: [...exchange, committedPlan],
    reply: () => replyText(answers.shift() ?? "Unused Title Here")(),
  });
  await h.emit("agent_end");
  assert.equal(h.name(), "Fix Login Bug");
  await h.emit("agent_end");
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].context.messages[0].content.includes("<current_title>Fix Login Bug</current_title>"), true);
  assert.equal(h.name(), "Fix Login Bug");
  assert.equal(h.written.at(-1).data.kind, "refine");
  assert.equal(h.written.at(-1).data.outcome, "kept");
  await h.emit("agent_end");
  assert.equal(h.requests.length, 2, "the refinement pass is spent");
});

test("a refinement that rewrites the title records generation two", async () => {
  const answers = ["Fix Login Bug", "Login Redirect Loop Fix"];
  const h = harness({
    branch: [...exchange, committedPlan],
    reply: () => replyText(answers.shift() ?? "Unused Title Here")(),
  });
  await h.emit("agent_end");
  await h.emit("agent_end");
  assert.equal(h.name(), "Login Redirect Loop Fix");
  assert.equal(h.written.at(-1).data.generation, 2);
});

test("a failed reply writes no name, warns once, and the cap stops the third try", async () => {
  const h = harness({ reply: async () => ({ stopReason: "error", errorMessage: "quota", content: [] }) });
  await h.emit("agent_end");
  assert.equal(h.name(), undefined);
  assert.match(h.notices[0]!, /Auto title skipped: quota/);
  await h.emit("agent_end");
  await h.emit("agent_end");
  assert.equal(h.requests.length, 3);
  await h.emit("agent_end");
  assert.equal(h.requests.length, 3, "three automatic tries per session, failures included");
  assert.equal(h.notices.length, 1, "the same reason is not repeated");
  assert.deepEqual(h.views.at(-1).rows.find((row: any) => row.label === "Status"), { label: "Status", value: "Skipped" });
});

test("the toggle action switches the automatic path off and on", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.action(AUTO_TITLE_TOGGLE_ACTION);
  await h.emit("agent_end");
  assert.equal(h.requests.length, 0);
  assert.equal(h.views.at(-1).rows[0].value, "Off");
  await h.action(AUTO_TITLE_TOGGLE_ACTION);
  await h.emit("agent_end");
  assert.equal(h.name(), "Fix Login Bug");
});

test("regenerate replaces an existing name, and a failure leaves it alone", async () => {
  const h = harness({ name: "Old name" });
  await h.emit("session_start");
  await h.action(AUTO_TITLE_REGENERATE_ACTION);
  assert.equal(h.name(), "Fix Login Bug");

  const failing = harness({ name: "Old name", reply: async () => { throw new Error("offline"); } });
  await failing.emit("session_start");
  await failing.action(AUTO_TITLE_REGENERATE_ACTION);
  assert.equal(failing.name(), "Old name");
});

test("a manual regenerate inside the cooldown is refused with the reason", async () => {
  const h = harness({ name: "Old name" });
  const { handler } = h.commands.get("auto-title");
  await handler("now", h.ctx);
  await handler("now", h.ctx);
  assert.equal(h.requests.length, 1);
  assert.match(h.notices.at(-1)!, /generated a moment ago/);
});

test("/auto-title now takes an optional hint as data; off disables; bad usage warns", async () => {
  const h = harness();
  const { handler } = h.commands.get("auto-title");
  await handler("now focus on the export feature", h.ctx);
  assert.equal(h.name(), "Fix Login Bug");
  assert.match(h.requests[0].context.messages[0].content, /<hint>focus on the export feature<\/hint>/);
  await handler("off", h.ctx);
  await handler("status", h.ctx);
  assert.match(h.notices.at(-1)!, /Auto title off/);
  await handler("bogus", h.ctx);
  assert.match(h.notices.at(-1)!, /Usage/);
});

test("a length stop retries with a larger budget, and partial text is still cleaned", async () => {
  let call = 0;
  const h = harness({
    reply: () => {
      call += 1;
      if (call === 1) return Promise.resolve({ stopReason: "length", content: [] });
      return Promise.resolve({ stopReason: "length", content: [{ type: "text", text: "Login Redirect Loop Fix" }] });
    },
  });
  await h.emit("agent_end");
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].options.maxTokens, 64, "a model without reasoning starts small");
  assert.equal(h.requests[1].options.maxTokens, 256, "the length stop retries at four times the budget");
  assert.equal(h.name(), "Login Redirect Loop Fix", "usable text in a length stop is still a title");
});

test("a length stop with no text is a clean rejection, not a token-cap error", async () => {
  const h = harness({ reply: async () => ({ stopReason: "length", content: [] }) });
  await h.emit("agent_end");
  assert.equal(h.name(), undefined);
  assert.match(h.notices[0]!, /no usable title/);
});

test("a session seeded from a parent fork is never auto-titled, and publishes nothing", async () => {
  const marker = {
    type: "custom",
    customType: "subagent-context:v1",
    data: { version: 1, mode: "fork", parentSession: "/p.jsonl", parentSessionId: "p", seededAt: new Date().toISOString() },
  };
  const h = harness({ branch: [marker, ...exchange] });
  await h.emit("session_start");
  await h.emit("agent_end");
  assert.equal(h.requests.length, 0);
  assert.equal(h.views.length, 0, "a child publishes nothing to the web");
});

test("the view validates, and the descriptor is registered and valid", () => {
  for (const phase of ["idle", "generating", "done", "failed"] as const) {
    const view = autoTitleWebView({ enabled: true, phase, title: "T", error: phase === "failed" ? "e" : undefined });
    assert.equal(validateView(view).ok, true, phase);
  }
  assert.equal(validatePlugin(autoTitlePlugin, ["auto-title.ts"]).ok, true);
  assert.deepEqual(validateRegistry(WEB_PLUGINS), []);
  assert.ok(WEB_PLUGINS.some((plugin) => plugin.id === AUTO_TITLE_PLUGIN_ID));
});

test("/title lock keeps a generated name and spends the refinement; a name you set is already yours", async () => {
  const h = harness({ branch: [...exchange, committedPlan] });
  const { handler } = h.commands.get("title");
  await h.emit("agent_end");
  await handler("lock", h.ctx);
  assert.match(h.notices.at(-1)!, /Title locked/);
  await h.emit("agent_end");
  assert.equal(h.requests.length, 1, "a locked title is not refined");

  const mine = harness({ name: "Mine" });
  await mine.commands.get("title").handler("lock", mine.ctx);
  assert.match(mine.notices.at(-1)!, /Already yours/);
});

test("/title status reports ownership, tries and the usage budget", async () => {
  const h = harness();
  const { handler } = h.commands.get("title");
  await h.emit("agent_end");
  await handler("status", h.ctx);
  assert.match(h.notices.at(-1)!, /source: generated; generations: 1\/3/);
  const card = h.views.at(-1).rows;
  assert.deepEqual(card.find((row: any) => row.label === "Source"), { label: "Source", value: "Generated" });
  assert.deepEqual(card.find((row: any) => row.label === "Generations"), { label: "Generations", value: "1 / 3" });
  assert.deepEqual(card.find((row: any) => row.label === "Model"), { label: "Model", value: "p/m" });
});

test("a name the person set reads as locked on the card", async () => {
  const h = harness({ name: "Mine" });
  await h.emit("session_start");
  const status = h.views.at(-1).rows.find((row: any) => row.label === "Status");
  assert.equal(status.value, "Locked (you named it)");
});

test("the on/off choice persists across processes", async () => {
  const first = harness();
  await first.commands.get("title").handler("off", first.ctx);
  assert.equal(JSON.parse(readFileSync(first.stateFile, "utf-8")).enabled, false);

  const second = harness({ stateFile: first.stateFile });
  await second.emit("agent_end");
  assert.equal(second.requests.length, 0, "the stored choice holds in a new process");

  await second.commands.get("title").handler("on", second.ctx);
  assert.equal(JSON.parse(readFileSync(second.stateFile, "utf-8")).enabled, true);
});
