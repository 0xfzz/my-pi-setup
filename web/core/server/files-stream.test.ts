// Regression tests for the Files download stream (streamFile). The failure
// mode being pinned: a client aborting a download mid-body used to leak the
// open FileHandle, and V8's later GC of that handle crashed the whole server
// with "EBADF: Closing file descriptor … on garbage collection failed".

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { parse as parseDisposition } from "content-disposition";
import { openFileDownload } from "./files.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "./main.ts";
import { registerWebPlugins } from "./plugin-host.ts";
import { WEB_PLUGINS } from "../../plugins/index.ts";
import {
  registerSession,
  type SessionCore,
  type SessionStateLite,
} from "./sessions.ts";

// File browsing is the Files plugin's own backend surface (/api/p/files/*), so
// the kernel host must be booted for these routes to exist at all.
const host = registerWebPlugins(WEB_PLUGINS);
await host.ready;

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
  return `${baseUrl}/api/p/files/download?sessionId=${SESSION_ID}&path=big.pdf`;
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

test("download ranges preserve the single-range and invalid-range fallback contract", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-files-ranges-"));
  const bytes = Buffer.from("0123456789");
  await writeFile(join(root, "big.pdf"), bytes);
  const cases = [
    { range: "bytes=2-4", status: 206, expected: "234", contentRange: "bytes 2-4/10" },
    { range: "bytes=7-", status: 206, expected: "789", contentRange: "bytes 7-9/10" },
    { range: "bytes=-3", status: 206, expected: "789", contentRange: "bytes 7-9/10" },
    { range: "bytes=-20", status: 206, expected: "0123456789", contentRange: "bytes 0-9/10" },
    { range: "bytes=8-99", status: 206, expected: "89", contentRange: "bytes 8-9/10" },
    ...["bytes=20-30", "bytes=-0", "bytes=5-2", "bytes=0-1,4-5", "bytes=0-x", "items=0-1", "bytes=1 - 2", "bytes=-"]
      .map(range => ({ range, status: 200, expected: "0123456789", contentRange: null })),
  ];
  try {
    await withServer(root, async base => {
      for (const fixture of cases) await t.test(fixture.range, async () => {
        const response = await fetch(await downloadUrl(base), { headers: { range: fixture.range } });
        assert.equal(response.status, fixture.status);
        assert.equal(response.headers.get("content-range"), fixture.contentRange);
        assert.equal(response.headers.get("content-length"), String(fixture.expected.length));
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        assert.equal(await response.text(), fixture.expected);
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("zero-byte downloads return an empty 200, including a requested range", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-files-empty-"));
  await writeFile(join(root, "big.pdf"), "");
  try {
    await withServer(root, async base => {
      for (const headers of [new Headers(), new Headers({ range: "bytes=0-" })]) {
        const response = await fetch(await downloadUrl(base), { headers });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-length"), "0");
        assert.equal((await response.arrayBuffer()).byteLength, 0);
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("download disposition forces executable/unknown content and safely encodes Unicode names", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-files-disposition-"));
  const names = ["page.html", "image.svg", "file.unknown-type", "résumé-文.pdf"];
  for (const name of names) await writeFile(join(root, name), "fixture");
  try {
    await withServer(root, async base => {
      for (const name of names) {
        const response = await fetch(`${base}/api/p/files/download?sessionId=${SESSION_ID}&path=${encodeURIComponent(name)}`);
        assert.equal(response.status, 200);
        const disposition = parseDisposition(response.headers.get("content-disposition")!);
        assert.equal(disposition.type, name.endsWith(".pdf") ? "inline" : "attachment");
        assert.equal(disposition.parameters.filename, name);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        await response.arrayBuffer();
      }
      const forced = await fetch(`${base}/api/p/files/download?sessionId=${SESSION_ID}&path=${encodeURIComponent(names[3]!)}&download=1`);
      assert.equal(parseDisposition(forced.headers.get("content-disposition")!).type, "attachment");
      await forced.arrayBuffer();
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a download reads its authorized descriptor even if its pathname is replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-files-descriptor-"));
  const path = join(root, "original.pdf");
  await writeFile(path, "authorized bytes");
  const opened = await openFileDownload({ root, path: "original.pdf", attachment: false });
  assert.ok(opened.ok);
  try {
    await rename(path, join(root, "moved.pdf"));
    await writeFile(join(root, "replacement.pdf"), "not authorized");
    await symlink(join(root, "replacement.pdf"), path);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.download.stream) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), "authorized bytes");
    const refused = await openFileDownload({ root, path: "original.pdf", attachment: false });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, "symlink");
  } finally {
    opened.download.stream.destroy();
    await opened.download.close();
    await opened.download.close(); // descriptor release is idempotent.
    await rm(root, { recursive: true, force: true });
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
