// The broadcast that keeps every open tab on the server's plugin set.
//
// `/api/plugins` is fetched once per page load, so a change the server never
// announces is a change an open tab never sees. These tests pin the two
// properties that matter: a visibility move is announced, and a move that
// leaves the served set unchanged is not.

import test from "node:test";
import assert from "node:assert/strict";

import { AuditLog } from "../plugin-contracts/kernel/audit.ts";
import type { WebPluginDescriptor } from "../plugin-contracts/descriptor.ts";
import { watchPluginRegistry, type ObservableRegistry } from "./plugin-registry-broadcast.ts";

function descriptor(id: string): WebPluginDescriptor {
  return {
    id,
    extension: id,
    title: id,
    surfaces: [{ kind: "page", path: `/plugins/${id}` }],
  };
}

/** A registry whose served set the test moves by hand. */
function fakeRegistry(initial: WebPluginDescriptor[]): ObservableRegistry & { serve(plugins: WebPluginDescriptor[]): void } {
  let served = initial;
  return {
    audit: new AuditLog(),
    visible: () => served,
    serve(plugins) {
      served = plugins;
    },
  };
}

test("a lifecycle move that changes the served set is announced", () => {
  const registry = fakeRegistry([descriptor("todo")]);
  let announcements = 0;
  watchPluginRegistry(registry, () => {
    announcements++;
  });

  registry.serve([descriptor("todo"), descriptor("files")]);
  registry.audit.append("enabled", "files", "operator enabled");

  assert.equal(announcements, 1, "the tab is told to re-read /api/plugins");
});

test("a lifecycle move that leaves the served set unchanged is silent", () => {
  const registry = fakeRegistry([descriptor("todo")]);
  let announcements = 0;
  watchPluginRegistry(registry, () => {
    announcements++;
  });

  // A reload that lands the same descriptor, a grant, a veto: the client's
  // registry is already correct, so a refetch would be pure noise.
  registry.audit.append("lifecycle", "todo", "reloaded");
  registry.audit.append("granted", "todo", "ui.publish");
  registry.audit.append("veto", "todo", "denied a pinned delete");

  assert.equal(announcements, 0);
});

test("a plugin disappearing (disable, quarantine, safe mode) is announced too", () => {
  const registry = fakeRegistry([descriptor("todo"), descriptor("files")]);
  let announcements = 0;
  watchPluginRegistry(registry, () => {
    announcements++;
  });

  registry.serve([descriptor("todo")]);
  registry.audit.append("quarantined", "files", "breaker tripped");
  assert.equal(announcements, 1);

  registry.serve([]);
  registry.audit.append("safe-mode", "kernel", "boot crash loop");
  assert.equal(announcements, 2);
});

test("unsubscribing stops the announcements", () => {
  const registry = fakeRegistry([descriptor("todo")]);
  let announcements = 0;
  const stop = watchPluginRegistry(registry, () => {
    announcements++;
  });
  stop();

  registry.serve([]);
  registry.audit.append("disabled", "todo", "operator disabled");

  assert.equal(announcements, 0);
});

test("a throwing observer cannot break the audit log", () => {
  const registry = fakeRegistry([descriptor("todo")]);
  registry.audit.subscribe(() => {
    throw new Error("observer exploded");
  });

  assert.doesNotThrow(() => registry.audit.append("enabled", "todo", "operator enabled"));
  assert.equal(registry.audit.list({ kind: "enabled" }).length, 1, "the entry is still recorded");
});
