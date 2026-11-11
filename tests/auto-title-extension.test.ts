import test from "node:test";
import assert from "node:assert/strict";

import autoTitleExtension from "../extensions/auto-title.ts";
import {
  AUTO_TITLE_PLUGIN_ID,
  AUTO_TITLE_REGENERATE_ACTION,
  AUTO_TITLE_TOGGLE_ACTION,
  autoTitleWebView,
} from "../lib/auto-title-web-view.ts";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT } from "../lib/web-plugins/actions.ts";
import { validatePlugin } from "../lib/web-plugins/descriptor.ts";
import { validateRegistry } from "../lib/web-plugins/registry.ts";
import { WEB_PLUGIN_VIEW_EVENT, validateView } from "../lib/web-plugins/view.ts";
import { WEB_PLUGINS, WEB_PLUGIN_OPT_OUT } from "../web-plugins/index.ts";
import { autoTitlePlugin } from "../web-plugins/auto-title.ts";

const exchange = [
  { type: "message", message: { role: "user", content: "fix the login bug" } },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Found it in auth.ts" }] } },
];

function harness(opts: { name?: string; branch?: any[]; reply?: () => Promise<any> } = {}) {
  let name = opts.name;
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  const views: any[] = [];
  const notices: string[] = [];
  const requests: any[] = [];
  const commands = new Map<string, any>();
  const pi: any = {
    on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerCommand: (command: string, spec: unknown) => commands.set(command, spec),
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
      getBranch: () => opts.branch ?? exchange,
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
  autoTitleExtension(pi);
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
  return { ctx, emit, action, views, notices, requests, commands, name: () => name, rename: (value: string) => { name = value; } };
}

test("an untitled session is named once, from the first exchange, on the current model", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.emit("agent_end");
  assert.equal(h.name(), "Fix Login Bug");
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].model, h.ctx.model);
  assert.ok(h.requests[0].options.maxTokens <= 256);
  assert.match(h.requests[0].context.messages[0].content, /fix the login bug/);
  assert.match(h.requests[0].context.messages[0].content, /Found it in auth\.ts/);
  await h.emit("agent_end");
  assert.equal(h.requests.length, 1, "a named session is not titled again");
});

test("an existing name is never replaced by the automatic path", async () => {
  const h = harness({ name: "My own name" });
  await h.emit("agent_end");
  assert.equal(h.requests.length, 0);
  assert.equal(h.name(), "My own name");
});

test("a name set while the request is in flight wins", async () => {
  let release: (value: unknown) => void = () => {};
  const h = harness({ reply: () => new Promise((resolve) => { release = resolve; }) });
  const pending = h.emit("agent_end");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.requests.length, 1, "the request is parked on the model");
  h.rename("Typed by the user");
  release({ stopReason: "stop", content: [{ type: "text", text: "Generated Title" }] });
  await pending;
  assert.equal(h.name(), "Typed by the user");
});

test("a failed reply keeps the session untitled, warns, and retries only once more", async () => {
  const h = harness({ reply: async () => ({ stopReason: "error", errorMessage: "quota", content: [] }) });
  await h.emit("agent_end");
  assert.equal(h.name(), undefined);
  assert.match(h.notices[0]!, /Auto title skipped: quota/);
  await h.emit("agent_end");
  await h.emit("agent_end");
  assert.equal(h.requests.length, 2);
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

test("/auto-title now generates; off disables; bad usage warns", async () => {
  const h = harness();
  const { handler } = h.commands.get("auto-title");
  await handler("now", h.ctx);
  assert.equal(h.name(), "Fix Login Bug");
  await handler("off", h.ctx);
  await handler("status", h.ctx);
  assert.match(h.notices.at(-1)!, /Auto title off/);
  await handler("bogus", h.ctx);
  assert.match(h.notices.at(-1)!, /Usage/);
});

test("a session seeded from a parent fork is never auto-titled", async () => {
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
  assert.ok(WEB_PLUGINS.some((p) => p.id === AUTO_TITLE_PLUGIN_ID));
  assert.equal(Object.hasOwn(WEB_PLUGIN_OPT_OUT, "auto-title"), false);
  assert.deepEqual(autoTitlePlugin.actions?.map((a) => a.id), [AUTO_TITLE_REGENERATE_ACTION, AUTO_TITLE_TOGGLE_ACTION]);
});
