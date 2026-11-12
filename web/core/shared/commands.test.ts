import test from "node:test";
import assert from "node:assert/strict";
import { annotateBuiltinCommands, filterCommands, type WebCommand } from "./commands.ts";

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
