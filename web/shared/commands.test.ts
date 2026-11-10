import test from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_COMMANDS, filterCommands } from "./commands.ts";

test("builtin commands mirror pi's set; ported and TUI-only are marked", () => {
  const names = BUILTIN_COMMANDS.map((command) => command.name);
  for (const expected of [
    "settings",
    "model",
    "tree",
    "thinking",
    "compact",
    "resume",
    "new",
    "quit",
  ]) {
    assert.ok(names.includes(expected), `/ ${expected} must be listed`);
  }
  // Every command carries exactly one disposition: web-ported (the web
  // dialog port), TUI-only, or dispatchable via the session.
  for (const command of BUILTIN_COMMANDS) {
    assert.ok(
      command.webPorted === true || command.tuiOnly === true || (command.webPorted === undefined && command.tuiOnly === undefined),
      `/ ${command.name} must be webPorted, tuiOnly, or dispatchable`,
    );
  }
  // The ported set: their TUI dialogs have web equivalents.
  for (const expected of ["model", "thinking", "session", "changelog", "copy", "export", "resume"]) {
    const command = BUILTIN_COMMANDS.find((entry) => entry.name === expected);
    assert.ok(command !== undefined && command.webPorted === true, `/ ${expected} is web-ported`);
  }
  assert.ok(BUILTIN_COMMANDS.every((command) => command.description !== undefined));
});

test("filterCommands matches by prefix, earliest match first", () => {
  const commands = [
    { name: "web", description: "web ui" },
    { name: "web-plugins", description: "plugins" },
    { name: "todo", description: "todos" },
  ];
  assert.deepEqual(filterCommands(commands, "/w"), []);
  assert.deepEqual(
    filterCommands(commands, "w").map((command) => command.name),
    ["web", "web-plugins"],
  );
  assert.deepEqual(
    filterCommands(commands, "we").map((command) => command.name),
    ["web", "web-plugins"],
  );
  assert.deepEqual(
    filterCommands(commands, "web-").map((command) => command.name),
    ["web-plugins"],
  );
  assert.deepEqual(filterCommands(commands, ""), commands);
});
