import test from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_COMMANDS, filterCommands } from "./commands.ts";

test("builtin commands mirror pi's set and are TUI-only", () => {
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
  assert.ok(BUILTIN_COMMANDS.every((command) => command.tuiOnly === true));
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
