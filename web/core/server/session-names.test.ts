import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSessionsForTests,
  listAllSessions,
  listDiskSessions,
  listLiveSessions,
  recordSessionName,
  registerSession,
  subscribeSessionDirectory,
  unregisterSession,
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

// Regression: the sidebar showed the folder instead of a generated title.
// The auto-title panel read the name from the session manager (so it looked
// right), while the sidebar row had none: the session had stopped being live,
// so its row came from the disk scan, and a TUI-owned session writes its name
// in the TUI process — the web server's copy of the file never had it.
test("a title the directory was told survives its session becoming a disk row", async () => {
  clearSessionsForTests();
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-names-detach-"));
  const projectDir = join(agentDir, "sessions", "slug");
  await mkdir(projectDir, { recursive: true });
  const id = "detach0001";
  const file = join(projectDir, `2026-11-12T00-00-00-000Z_${id}.jsonl`);
  // The file carries no session_info line: the title lives in the TUI process.
  await writeFile(file, `${header(id)}\n${message("hi")}\n`);

  const core = fakeCore(id);
  registerSession(core, "/tmp/work", file);
  core.emit({ type: "session_info_changed", name: "How to test the mobile ILP epic" });
  assert.equal(
    (await listAllSessions({ agentDir })).find((s) => s.id === id)?.name,
    "How to test the mobile ILP epic",
  );

  unregisterSession(id);
  const row = (await listAllSessions({ agentDir })).find((s) => s.id === id);
  assert.equal(row?.live, false, "the row is the disk row now");
  assert.equal(row?.name, "How to test the mobile ILP epic", "the title survives the transition");
  clearSessionsForTests();
});

test("a name the file carries is used when the directory was never told one", async () => {
  clearSessionsForTests();
  const listed = await diskWith({ eeee5555: sessionText("eeee5555", [info("From the file")]) });
  assert.equal(listed.find((s) => s.id === "eeee5555")?.name, "From the file");
  clearSessionsForTests();
});

test("a rename heard live wins over a stale name still in the file", async () => {
  clearSessionsForTests();
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-names-fresh-"));
  const projectDir = join(agentDir, "sessions", "slug");
  await mkdir(projectDir, { recursive: true });
  const id = "ffff6666";
  const file = join(projectDir, `2026-11-12T00-00-00-000Z_${id}.jsonl`);
  // The file's latest name predates the rename this process observed.
  await writeFile(file, `${[header(id), info("Old name")].join("\n")}\n`);

  const core = fakeCore(id);
  registerSession(core, "/tmp/work", file);
  core.emit({ type: "session_info_changed", name: "New name" });
  unregisterSession(id);

  assert.equal((await listAllSessions({ agentDir })).find((s) => s.id === id)?.name, "New name");
  clearSessionsForTests();
});

test("a cleared name is not resurrected from the file", async () => {
  clearSessionsForTests();
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-names-clear-"));
  const projectDir = join(agentDir, "sessions", "slug");
  await mkdir(projectDir, { recursive: true });
  const id = "aaaa7777";
  const file = join(projectDir, `2026-11-12T00-00-00-000Z_${id}.jsonl`);
  // A cleared name is the file's own latest session_info, so the scan agrees.
  await writeFile(file, `${[header(id), info("Named once"), info("")].join("\n")}\n`);

  const core = fakeCore(id, "Named once");
  registerSession(core, "/tmp/work", file);
  core.emit({ type: "session_info_changed", name: undefined });
  unregisterSession(id);

  assert.equal((await listAllSessions({ agentDir })).find((s) => s.id === id)?.name, undefined);
  clearSessionsForTests();
});

// Regression: a generated title must be findable by search. The list is a
// window of recent sessions, and the query used to be applied to that window
// only — so a title on an older session could not be found by its own name.
test("search reaches a titled session that fell out of the recent window", async () => {
  clearSessionsForTests();
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-names-search-"));
  const dir = join(agentDir, "sessions", "slug");
  await mkdir(dir, { recursive: true });

  // The titled session is the oldest of 40: past the 30-row list window.
  const titled = "titled0001";
  const titledFile = join(dir, `2026-01-01T00-00-00-000Z_${titled}.jsonl`);
  await writeFile(titledFile, `${header(titled)}\n${info("How to test the mobile ILP epic")}\n`);
  await utimes(titledFile, new Date("2026-01-01"), new Date("2026-01-01"));
  for (let i = 0; i < 39; i++) {
    const id = `filler${String(i).padStart(4, "0")}`;
    const file = join(dir, `2026-02-01T00-00-00-000Z_${id}.jsonl`);
    await writeFile(file, `${header(id)}\n`);
    await utimes(file, new Date("2026-02-01"), new Date("2026-02-01"));
  }

  const listed = await listAllSessions({ agentDir });
  assert.equal(listed.length, 30, "the list stays a recent window");
  assert.equal(listed.some((s) => s.id === titled), false, "the titled session is outside it");

  const found = await listAllSessions({ agentDir, query: "mobile ILP" });
  assert.deepEqual(found.map((s) => [s.id, s.name]), [[titled, "How to test the mobile ILP epic"]]);
  clearSessionsForTests();
});

test("search matches the id and the project path as well as the name", async () => {
  clearSessionsForTests();
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-names-fields-"));
  const dir = join(agentDir, "sessions", "slug");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "2026-04-01T00-00-00-000Z_ffff8888.jsonl"), `${header("ffff8888")}\n${info("Plan review")}\n`);
  await writeFile(join(dir, "2026-04-02T00-00-00-000Z_ffff9999.jsonl"), `${header("ffff9999")}\n${info("Cache audit")}\n`);

  assert.deepEqual((await listAllSessions({ agentDir, query: "plan" })).map((s) => s.id), ["ffff8888"]);
  assert.deepEqual((await listAllSessions({ agentDir, query: "ffff9999" })).map((s) => s.id), ["ffff9999"]);
  // Every fixture shares the project path, so a path query matches both.
  assert.deepEqual((await listAllSessions({ agentDir, query: "/tmp/work" })).map((s) => s.id).sort(), ["ffff8888", "ffff9999"]);
  clearSessionsForTests();
});

test("search never widens the list when no query is given", async () => {
  clearSessionsForTests();
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-names-nowindow-"));
  const dir = join(agentDir, "sessions", "slug");
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < 35; i++) {
    const id = `plain${String(i).padStart(4, "0")}`;
    await writeFile(join(dir, `2026-03-01T00-00-00-000Z_${id}.jsonl`), `${header(id)}\n`);
  }
  assert.equal((await listAllSessions({ agentDir })).length, 30);
  clearSessionsForTests();
});
