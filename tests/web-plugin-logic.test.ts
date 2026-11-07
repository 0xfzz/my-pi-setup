import test from "node:test";
import assert from "node:assert/strict";

import { CapabilityError, type Capability } from "../lib/web-plugins/kernel/capabilities.ts";
import { HookBus } from "../lib/web-plugins/kernel/hooks.ts";
import { PluginStorage } from "../lib/web-plugins/kernel/storage.ts";
import { ServiceRegistry } from "../lib/web-plugins/kernel/services.ts";

const grants = (...caps: string[]): Capability[] => caps.map((c) => {
  const i = c.indexOf(":");
  return i === -1 ? { kind: c as Capability["kind"] } : { kind: c.slice(0, i) as Capability["kind"], arg: c.slice(i + 1) };
});

test("waterfall handlers run by priority and each sees the previous value", async () => {
  const failures: unknown[] = [];
  const bus = new HookBus({ onFailure: (f) => failures.push(f) });
  const owner = { pluginId: "acme.zen", grants: grants("hooks.transform:prompt.before-send") };
  bus.register(owner, "waterfall", "prompt.before-send", (p: unknown) => `${p} [low]`, 1);
  bus.register({ pluginId: "acme.alpha", grants: grants("hooks.transform:prompt.before-send") }, "waterfall", "prompt.before-send", (p: unknown) => `${p} [high]`, 5);
  const out = await bus.waterfall("prompt.before-send", "hi", { session: "s1" });
  assert.equal(out, "hi [high] [low]");
  assert.deepEqual(failures, []);
});

test("a waterfall handler that throws or times out is skipped and the chain continues", async () => {
  const failures: Array<{ reason: string; pluginId: string }> = [];
  const bus = new HookBus({ budgetMs: 20, onFailure: (f) => failures.push(f) });
  bus.register({ pluginId: "acme.boom", grants: grants("hooks.transform:prompt.before-send") }, "waterfall", "prompt.before-send", () => {
    throw new Error("nope");
  }, 3);
  bus.register({ pluginId: "acme.slow", grants: grants("hooks.transform:prompt.before-send") }, "waterfall", "prompt.before-send", () => new Promise(() => undefined), 2);
  bus.register({ pluginId: "acme.ok", grants: grants("hooks.transform:prompt.before-send") }, "waterfall", "prompt.before-send", (p: unknown) => `${p}!`, 1);
  assert.equal(await bus.waterfall("prompt.before-send", "x", {}), "x!");
  assert.deepEqual(failures.map((f) => [f.pluginId, f.reason]), [["acme.boom", "error"], ["acme.slow", "timeout"]]);
});

test("a bail handler's deny stops the action with the reason and the vetoing plugin", async () => {
  const bus = new HookBus();
  bus.register({ pluginId: "acme.guard", grants: grants("hooks.veto:session.before-delete") }, "bail", "session.before-delete", (s: any) =>
    s.pinned ? { deny: "Pinned sessions can't be deleted." } : undefined);
  assert.deepEqual(await bus.bail("session.before-delete", { pinned: true }), {
    denied: true,
    reason: "Pinned sessions can't be deleted.",
    pluginId: "acme.guard",
  });
  assert.deepEqual(await bus.bail("session.before-delete", { pinned: false }), { denied: false });
});

test("an event handler is observed, its failure does not reach the caller, and it cannot change the result", async () => {
  const seen: unknown[] = [];
  const bus = new HookBus({ budgetMs: 50 });
  bus.register({ pluginId: "acme.metrics", grants: grants("hooks.observe:session.settled") }, "event", "session.settled", (p: unknown) => {
    seen.push(p);
  });
  bus.register({ pluginId: "acme.bad", grants: grants("hooks.observe:session.settled") }, "event", "session.settled", () => {
    throw new Error("ignored");
  });
  await bus.event("session.settled", { session: "s1" });
  assert.deepEqual(seen, [{ session: "s1" }]);
});

test("registration is refused for protected points, wrong kinds, unknown points and ungranted plugins (AC9, AC10)", () => {
  const bus = new HookBus();
  const owner = { pluginId: "acme.zen", grants: grants("hooks.veto:session.before-delete") };
  assert.throws(() => bus.register({ pluginId: "acme.zen", grants: grants("hooks.observe:core.auth.session") }, "event", "core.auth.session", () => undefined), /protected point/);
  assert.throws(() => bus.register(owner, "waterfall", "session.before-delete", () => undefined), /is a bail point, not a waterfall hook/);
  assert.throws(() => bus.register(owner, "bail", "chat.message.bubble", () => undefined), /unknown extension point/);
  assert.throws(() => bus.register({ pluginId: "acme.zen", grants: [] }, "bail", "session.before-delete", () => undefined), CapabilityError);
});

test("a plugin may hook its own namespace without a grant, but not another plugin's points for free", () => {
  const bus = new HookBus();
  assert.doesNotThrow(() => bus.register({ pluginId: "acme.zen", grants: [] }, "event", "acme.zen.ready", () => undefined));
  assert.throws(() => bus.register({ pluginId: "acme.zen", grants: [] }, "event", "acme.other.ready", () => undefined), /unknown extension point/);
});

test("removeOwner removes every hook a plugin registered, in one step", async () => {
  const bus = new HookBus();
  const owner = { pluginId: "acme.zen", grants: grants("hooks.transform:prompt.before-send") };
  bus.register(owner, "waterfall", "prompt.before-send", (p: unknown) => `${p}!`);
  bus.register(owner, "waterfall", "prompt.before-send", (p: unknown) => `${p}?`);
  assert.equal(bus.removeOwner("acme.zen"), 2);
  assert.equal(await bus.waterfall("prompt.before-send", "x", {}), "x");
});

test("a returned unregister function removes just that handler", async () => {
  const bus = new HookBus();
  const owner = { pluginId: "acme.zen", grants: grants("hooks.transform:prompt.before-send") };
  const off = bus.register(owner, "waterfall", "prompt.before-send", (p: unknown) => `${p}!`);
  off();
  assert.equal(await bus.waterfall("prompt.before-send", "x", {}), "x");
});

test("services: a replacement wins over a provider, decorators wrap it outermost-first by priority", () => {
  const reg = new ServiceRegistry();
  const base = { pluginId: "core.chat", grants: grants("services.provide:service:title-generator") };
  reg.register(base, "title-generator", "provide", (text: string) => `base(${text})`);
  reg.register({ pluginId: "acme.titles", grants: grants("services.replace:service:title-generator") }, "title-generator", "replace", (text: string) => `replaced(${text})`);
  const deco = (tag: string, priority: number) => reg.register({ pluginId: `acme.${tag}`, grants: grants("services.replace:service:title-generator") }, "title-generator", "decorate", (next: any) => (text: string) => `${tag}[${next(text)}]`, priority);
  deco("inner", 1);
  deco("outer", 9);
  const fn = reg.resolve<(text: string) => string>("title-generator")!;
  assert.equal(fn("x"), "outer[inner[replaced(x)]]");
});

test("services: two exclusive replacements at the same priority conflict, and the later one is refused with a named diagnostic", () => {
  const reg = new ServiceRegistry();
  reg.register({ pluginId: "acme.one", grants: grants("services.replace:service:notifier") }, "notifier", "replace", () => "one", 4);
  assert.throws(
    () => reg.register({ pluginId: "acme.two", grants: grants("services.replace:service:notifier") }, "notifier", "replace", () => "two", 4),
    /exclusive replacement conflict on "service:notifier" at priority 4: acme\.one already holds it/,
  );
  assert.equal(reg.conflictLog().length, 1);
  assert.equal(reg.resolve<() => string>("notifier")!(), "one");
});

test("services: an unprovided service resolves to undefined; removing an owner restores the base", () => {
  const reg = new ServiceRegistry();
  assert.equal(reg.resolve("model.pick"), undefined);
  reg.register({ pluginId: "core.chat", grants: grants("services.provide:service:model.pick") }, "model.pick", "provide", () => "base");
  reg.register({ pluginId: "acme.pick", grants: grants("services.replace:service:model.pick") }, "model.pick", "replace", () => "alt");
  assert.equal(reg.resolve<() => string>("model.pick")!(), "alt");
  assert.equal(reg.removeOwner("acme.pick"), 1);
  assert.equal(reg.resolve<() => string>("model.pick")!(), "base");
});

test("services: protected points cannot be replaced and ungranted replacements are denied", () => {
  const reg = new ServiceRegistry();
  assert.throws(() => reg.register({ pluginId: "acme.x", grants: grants("services.replace:service:notifier") }, "core.auth.session", "replace", () => undefined), /protected/);
  assert.throws(() => reg.register({ pluginId: "acme.x", grants: [] }, "notifier", "replace", () => undefined), CapabilityError);
});

test("storage: values round-trip per scope and per plugin, and each scope needs its grant", () => {
  const store = new PluginStorage();
  const zen = store.forPlugin({ pluginId: "acme.zen", grants: grants("storage:project", "storage:session") });
  const other = store.forPlugin({ pluginId: "acme.other", grants: grants("storage:project") });
  zen.set("project", "layout", { zen: true });
  assert.deepEqual(zen.get("project", "layout"), { zen: true });
  assert.equal(other.get("project", "layout"), undefined, "plugins do not see each other's data");
  assert.throws(() => zen.set("global", "theme", "dark"), CapabilityError);
});

test("storage: update is atomic per call and an oversize write is rejected with the quota named", () => {
  const store = new PluginStorage({ quotaBytes: 64 });
  const zen = store.forPlugin({ pluginId: "acme.zen", grants: grants("storage:session") });
  assert.equal(zen.update<number>("session", "turns", (n = 0) => n + 1), 1);
  assert.equal(zen.update<number>("session", "turns", (n = 0) => n + 1), 2);
  assert.throws(() => zen.set("session", "big", "x".repeat(200)), /storage quota of 64 bytes would be exceeded/);
  assert.equal(zen.get("session", "big"), undefined);
});

test("storage: keys are validated, and snapshot/restore keeps data across a host restart", () => {
  const store = new PluginStorage();
  const zen = store.forPlugin({ pluginId: "acme.zen", grants: grants("storage:project") });
  assert.throws(() => zen.set("project", "../escape", 1), /not a valid key/);
  zen.set("project", "layout", [1, 2]);
  const restored = new PluginStorage();
  restored.restore(JSON.parse(JSON.stringify(store.snapshot())));
  assert.deepEqual(restored.forPlugin({ pluginId: "acme.zen", grants: grants("storage:project") }).get("project", "layout"), [1, 2]);
  store.purge("acme.zen");
  assert.equal(zen.get("project", "layout"), undefined);
});
