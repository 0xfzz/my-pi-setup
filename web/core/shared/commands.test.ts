import test from "node:test";
import assert from "node:assert/strict";
import {
  annotateBuiltinCommands,
  annotateContributedCommands,
  filterCommands,
  type WebCommand,
} from "./commands.ts";

test("annotateBuiltinCommands merges pi's runtime list with the web's presentation flags", () => {
  // pi's BUILTIN_SLASH_COMMANDS shape (a subset).
  const piList = [
    { name: "compact", description: "Manually compact the session context" },
    { name: "model", description: "Select model", argumentHint: "provider/id" },
    { name: "quit", description: "Quit pi" },
    { name: "future-command", description: "Shipped by a newer pi" },
  ];
  const annotated = annotateBuiltinCommands(piList);
  assert.deepEqual(annotated[0], { name: "compact", description: "Manually compact the session context", web: true });
  assert.deepEqual(annotated[1], { name: "model", description: "Select model", webPorted: true });
  assert.deepEqual(annotated[2], { name: "quit", description: "Quit pi", web: true });
  // Unknown future commands pass through unflagged — forward compatibility.
  assert.deepEqual(annotated[3], { name: "future-command", description: "Shipped by a newer pi" });
});

test("the built-in coverage policy: every pi built-in has a web disposition", () => {
  // pi's real runtime list — the 24 built-ins.
  const piList = [
    "settings", "model", "tree", "thinking", "scoped-models", "export", "import", "share",
    "bug", "copy", "name", "session", "changelog", "hotkeys", "fork", "clone", "trust",
    "login", "logout", "new", "compact", "resume", "reload", "quit",
  ].map((name) => ({ name, description: `${name} description` }));
  const annotated = annotateBuiltinCommands(piList);
  const dispatchable = annotated.filter((command) => command.web === true || command.webPorted === true);
  const tuiOnly = annotated.filter((command) => command.tuiOnly === true);
  // Every built-in dispatches from the web: 13 web-ported (client dialogs/
  // actions for /settings, /scoped-models, /trust, /login, /logout, /model,
  // /thinking, /session, /changelog, /copy, /export, /resume, /hotkeys) +
  // 11 through the web_command channel (/compact, /name, /new, /clone,
  // /reload, /fork, /tree, /import, /quit, /share, /bug). Nothing remains
  // tuiOnly.
  assert.equal(dispatchable.length, 24);
  assert.deepEqual(tuiOnly.map((command) => command.name).sort(), []);
});

test("a contributed web command's flags land on its pi entry, not a duplicate", () => {
  const commands = annotateBuiltinCommands([{ name: "provider", description: "Manage providers" }]);
  const merged = annotateContributedCommands(commands, [
    { name: "provider", description: "Manage providers", managesModels: true, addsModels: true },
    { name: "only-web", description: "Contributed, not a pi command" },
  ]);

  const provider = merged.filter((command) => command.name === "provider");
  assert.equal(provider.length, 1, "the command is listed once");
  assert.equal(provider[0]?.web, true, "the palette dispatches it through web_command");
  assert.equal(provider[0]?.managesModels, true, "it gets a page in the shared settings dialog");
  assert.equal(provider[0]?.addsModels, true, "it is the picker's add entry");
  assert.equal(provider[0]?.description, "Manage providers");

  const appended = merged.find((command) => command.name === "only-web");
  assert.equal(appended?.web, true);
  assert.equal(appended?.managesModels, undefined);
});

test("a managesModels command carries its settingsEntry sidebar label", () => {
  const merged = annotateContributedCommands([], [
    { name: "provider", description: "Manage providers", managesModels: true, settingsEntry: "Provider", settingsPlugin: "providers" },
    { name: "router", description: "Manage routers", managesModels: true },
    { name: "not-models", description: "Not a catalogue command", settingsEntry: "Nope" },
  ]);

  const provider = merged.find((command) => command.name === "provider");
  assert.equal(provider?.settingsEntry, "Provider", "the declared label travels");
  assert.equal(provider?.settingsPlugin, "providers", "the explicit pane owner travels");
  const router = merged.find((command) => command.name === "router");
  assert.equal(router?.managesModels, true);
  assert.equal(router?.settingsEntry, undefined, "no label declared, the command name is the label");
  assert.equal(router?.addsModels, undefined, "a second catalogue page must not claim the picker's add entry");
  const notModels = merged.find((command) => command.name === "not-models");
  assert.equal(
    notModels?.settingsEntry,
    undefined,
    "a settingsEntry without managesModels is meaningless and dropped",
  );
});

test("filterCommands ranks by prefix position", () => {
  const commands: WebCommand[] = [
    { name: "export" },
    { name: "scoped-models" },
    { name: "model" },
  ];
  assert.deepEqual(filterCommands(commands, "m").map((command) => command.name), ["model"]);
  const mixed: WebCommand[] = [{ name: "new-name" }, { name: "name" }];
  assert.deepEqual(filterCommands(mixed, "n").map((command) => command.name), ["new-name", "name"]);
  assert.deepEqual(filterCommands(mixed, "zzz"), []);
});
