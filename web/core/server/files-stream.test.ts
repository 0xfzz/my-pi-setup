// Regression tests for the Files download stream (streamFile). The failure
// mode being pinned: a client aborting a download mid-body used to leak the
// open FileHandle, and V8's later GC of that handle crashed the whole server
// with "EBADF: Closing file descriptor … on garbage collection failed".

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "./main.ts";
import {
  registerSession,
  type SessionCore,
  type SessionStateLite,
} from "./sessions.ts";

const SESSION_ID = "files-stream-session";
/** Big enough that one chunk is never the whole body: aborts land mid-stream. */
const PAYLOAD_BYTES = 4 * 1024 * 1024;

function fakeCore(id: string): SessionCore {
  const state: SessionStateLite = {
    sessionId: id,
    sessionFile: "",
    isStreaming: false,
    isBashRunning: false,
    isCompacting: false,
    model: undefined,
    contextUsage: null,
    thinkingLevel: "off",
  };
  return {
    sessionId: id,
    subscribe: () => () => {},
    prompt: async () => {},
    abort: async () => {},
    isStreaming: () => false,
    getState: () => state,
  };
}

/** Linux-only: how many descriptors this process holds. -1 elsewhere. */
function openFdCount(): number {
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    return -1;
  }
}

/** Poll until the condition holds or the budget runs out (client/socket teardown is async). */
async function until(condition: () => boolean, budgetMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

async function withServer(fixtureRoot: string, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  registerSession(fakeCore(SESSION_ID), fixtureRoot, "");
  const handle = await startWebServer({ port: 0, host: "127.0.0.1" });
  try {
    await fn(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

async function downloadUrl(baseUrl: string): Promise<string> {
  return `${baseUrl}/api/agent/${SESSION_ID}/files/download?path=big.pdf`;
}

test("a full download streams the exact bytes inline", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-files-stream-"));
  const payload = Buffer.alloc(PAYLOAD_BYTES, 0x5a);
  await writeFile(join(fixtureRoot, "big.pdf"), payload);
  try {
    await withServer(fixtureRoot, async (baseUrl) => {
      const res = await fetch(await downloadUrl(baseUrl));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/pdf");
      assert.match(res.headers.get("content-disposition") ?? "", /^inline/);
      const body = Buffer.from(await res.arrayBuffer());
      assert.equal(body.length, payload.length);
      assert.ok(body.equals(payload), "the streamed bytes must match the file");
    });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("a range download returns the requested slice", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-files-stream-"));
  const payload = Buffer.alloc(PAYLOAD_BYTES, 0x5a);
  await writeFile(join(fixtureRoot, "big.pdf"), payload);
  try {
    await withServer(fixtureRoot, async (baseUrl) => {
      const res = await fetch(await downloadUrl(baseUrl), { headers: { Range: "bytes=100-199" } });
      assert.equal(res.status, 206);
      assert.equal(res.headers.get("content-range"), `bytes 100-199/${payload.length}`);
      const body = Buffer.from(await res.arrayBuffer());
      assert.equal(body.length, 100);
      assert.ok(body.equals(payload.subarray(100, 200)));
    });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("an aborted download must not leak the file descriptor or kill the server", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-files-stream-"));
  const payload = Buffer.alloc(PAYLOAD_BYTES, 0x5a);
  await writeFile(join(fixtureRoot, "big.pdf"), payload);
  try {
    await withServer(fixtureRoot, async (baseUrl) => {
      const url = await downloadUrl(baseUrl);
      const baseline = openFdCount();

      // Twenty clients each pull one chunk and hang up mid-body — exactly
      // what a browser does when the user navigates away from a PDF preview.
      for (let i = 0; i < 20; i += 1) {
        const controller = new AbortController();
        const res = await fetch(url, { signal: controller.signal });
        const reader = res.body!.getReader();
        await reader.read();
        controller.abort();
        await reader.cancel().catch(() => {});
      }

      // Every fd from those aborted streams must be released. A small slack
      // covers the keep-alive socket cycling; the old leak added one fd per
      // abort, which no slack hides.
      const released = await until(() => {
        if (openFdCount() === -1) return true; // not Linux: nothing to count
        return openFdCount() <= baseline + 4;
      });
      if (openFdCount() !== -1) {
        assert.ok(released, `descriptors must be released after aborts (baseline ${baseline}, now ${openFdCount()})`);
      }

      // And the server is still serving: a fresh full download works.
      const after = await fetch(url);
      assert.equal(after.status, 200);
      assert.equal((await after.arrayBuffer()).byteLength, payload.length);
    });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
