import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSessionsForTests,
  listDiskSessions,
  listLiveSessions,
  recordSessionName,
  registerSession,
  subscribeSessionDirectory,
  type SessionCore,
  type SessionDirectoryEvent,
  type SessionStateLite,
} from "./sessions.ts";

const header = (id: string) => JSON.stringify({ type: "session", id, cwd: "/tmp/work" });
const info = (name: string) => JSON.stringify({ type: "session_info", id: "i", name });
const message = (text: string) => JSON.stringify({ type: "message", message: { role: "user", content: text } });

/** A session file whose latest name sits `padding` bytes before the end. */
function sessionText(id: string, lines: string[], padding = 0): string {
  const filler = padding > 0 ? `${message("x".repeat(padding))}\n` : "";
  return [header(id), ...lines, filler].filter(Boolean).join("\n") + "\n";
}

async function diskWith(files: Record<string, string>) {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-names-"));
  const projectDir = join(agentDir, "sessions", "slug");
  await mkdir(projectDir, { recursive: true });
  for (const [id, text] of Object.entries(files)) {
    await writeFile(join(projectDir, `2026-11-12T00-00-00-000Z_${id}.jsonl`), text);
  }
  return listDiskSessions({ agentDir, limit: 50 });
}

test("a disk session's name is the latest session_info, found far from the end of a long file", async () => {
  const longAfter = sessionText("aaaa1111", [info("Early name"), info("Latest name")], 200_000);
  const [session] = (await diskWith({ aaaa1111: longAfter })).filter((s) => s.id === "aaaa1111");
  assert.equal(session?.name, "Latest name");
});

test("a cleared name leaves the session unnamed, and an unnamed session has no name", async () => {
  const cleared = sessionText("bbbb2222", [info("Named once"), info("")]);
  const unnamed = sessionText("cccc3333", [message("no name here")]);
  const listed = await diskWith({ bbbb2222: cleared, cccc3333: unnamed });
  assert.equal(listed.find((s) => s.id === "bbbb2222")?.name, undefined);
  assert.equal(listed.find((s) => s.id === "cccc3333")?.name, undefined);
});

test("a name whose line is cut at the chunk boundary is still read whole", async () => {
  const boundary = sessionText("dddd4444", [info("Boundary safe name")], 131_000);
  const [session] = (await diskWith({ dddd4444: boundary })).filter((s) => s.id === "dddd4444");
  assert.equal(session?.name, "Boundary safe name");
});

function fakeCore(sessionId: string, name?: string) {
  const listeners = new Set<(event: unknown) => void>();
  const state: SessionStateLite = {
    isStreaming: false,
    isBashRunning: false,
    isCompacting: false,
    contextUsage: null,
  } as SessionStateLite;
  const core = {
    sessionId,
    subscribe: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: async () => {},
    abort: async () => {},
    isStreaming: () => false,
    getState: () => state,
    getSessionName: () => name,
    emit: (event: unknown) => { for (const listener of listeners) listener(event); },
  };
  return core as SessionCore & { emit(event: unknown): void };
}

test("a live session carries its name, and a rename is pushed once per change", () => {
  clearSessionsForTests();
  const core = fakeCore("live-1", "Seeded name");
  registerSession(core, "/tmp/work", "");
  assert.equal(listLiveSessions().find((s) => s.id === "live-1")?.name, "Seeded name");

  const events: SessionDirectoryEvent[] = [];
  const unsubscribe = subscribeSessionDirectory((event) => events.push(event));
  core.emit({ type: "session_info_changed", name: "Generated Title" });
  core.emit({ type: "session_info_changed", name: "Generated Title" });
  recordSessionName("live-1", "Generated Title");
  unsubscribe();

  assert.deepEqual(events, [{ type: "session_renamed", id: "live-1", name: "Generated Title" }]);
  assert.equal(listLiveSessions().find((s) => s.id === "live-1")?.name, "Generated Title");
  clearSessionsForTests();
});

test("a cleared live name is removed from the list and announced as an empty name", () => {
  clearSessionsForTests();
  const core = fakeCore("live-2", "Named");
  registerSession(core, "/tmp/work", "");
  const events: SessionDirectoryEvent[] = [];
  const unsubscribe = subscribeSessionDirectory((event) => events.push(event));
  core.emit({ type: "session_info_changed", name: undefined });
  unsubscribe();
  assert.deepEqual(events, [{ type: "session_renamed", id: "live-2", name: "" }]);
  assert.equal(listLiveSessions().find((s) => s.id === "live-2")?.name, undefined);
  clearSessionsForTests();
});
