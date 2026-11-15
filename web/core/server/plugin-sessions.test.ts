// The session's announced web commands.
//
// Several extensions contribute commands to one session (the provider editor,
// the router, anything installed beside them), and each announces only its own
// list. The host therefore merges by command name: an announcement is a claim
// about the names it lists, never a replacement of the whole session's list.
//
// The failure this pins: when a second contributor announced, the first one's
// commands vanished — a settings page or the model picker's "+ Add models"
// entry silently disappeared from the web while the TUI still had it.

import assert from "node:assert/strict";
import test from "node:test";

import { mergeAnnouncedCommands } from "./plugin-sessions.ts";
import type { WebCommandDescriptor } from "../plugin-contracts/web-commands.ts";

const provider: WebCommandDescriptor = {
  name: "provider",
  description: "Add a provider or a model (web)",
  managesModels: true,
  addsModels: true,
  settingsEntry: "Provider",
  settingsPlugin: "providers",
};

const router: WebCommandDescriptor = {
  name: "router",
  description: "Routes and pools (web)",
  managesModels: true,
  settingsEntry: "Router",
  settingsPlugin: "router",
};

test("a second contributor's announcement keeps the first one's commands", () => {
  const afterProvider = mergeAnnouncedCommands([], [provider]);
  const afterRouter = mergeAnnouncedCommands(afterProvider, [router]);
  assert.deepEqual(afterRouter.map((command) => command.name), ["provider", "router"],
    "the router must not erase the provider editor");
  assert.equal(afterRouter.find((command) => command.name === "provider")?.addsModels, true);
});

test("re-announcing a name replaces that descriptor instead of listing it twice", () => {
  const once = mergeAnnouncedCommands([], [provider, router]);
  const twice = mergeAnnouncedCommands(once, [{ ...router, description: "updated" }]);
  assert.deepEqual(twice.map((command) => command.name), ["provider", "router"]);
  assert.equal(twice.find((command) => command.name === "router")?.description, "updated");
});

test("an empty announcement changes nothing", () => {
  const current = mergeAnnouncedCommands([], [provider]);
  assert.deepEqual(mergeAnnouncedCommands(current, []), current);
});
