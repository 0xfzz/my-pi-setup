import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startWebServer, resolveStaticPath } from "./main.ts";
import { registerWebPlugins } from "./plugin-host.ts";
import { WEB_PLUGINS } from "../../plugins/index.ts";
import {
  clearSessionsForTests,
  registerSession,
  type SessionCore,
  type SessionStateLite,
} from "./sessions.ts";

registerWebPlugins(WEB_PLUGINS);

test.afterEach(() => {
  clearSessionsForTests();
});

/** Read SSE frames from a stream until `predicate` matches the buffered text. */
function createFrameReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  return async function readUntil(predicate: (text: string) => boolean, timeoutMs = 5000): Promise<string> {
    if (predicate(buffer)) return buffer;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);
      if (chunk === null || chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (predicate(buffer)) return buffer;
    }
    throw new Error(`timed out waiting for SSE frame; received: ${JSON.stringify(buffer.slice(0, 500))}`);
  };
}

async function withServer(
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const handle = await startWebServer({ port: 0, host: "127.0.0.1" });
  try {
    await fn(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

test("health endpoint reports service identity", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    const body = (await res.json()) as { ok?: boolean; service?: string };
    assert.equal(body.ok, true);
    assert.equal(body.service, "pi-web-minimal");
  });
});

test("directories endpoint lists subdirectories for the picker", async () => {
  await withServer(async (baseUrl) => {
    const repo = resolve(import.meta.dirname, "../../..");
    const res = await fetch(`${baseUrl}/api/directories?path=${encodeURIComponent(repo)}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      path?: string;
      parent?: string | null;
      entries?: Array<{ name: string; path: string }>;
    };
    assert.equal(body.path, repo);
    assert.equal(typeof body.parent, "string");
    const names = (body.entries ?? []).map((entry) => entry.name);
    for (const expected of ["web", "lib", "extensions"]) {
      assert.ok(names.includes(expected), `${expected} must be listed`);
    }
    // Hidden directories are skipped.
    assert.ok(!names.some((name) => name.startsWith(".")), "no hidden dirs");

    const bad = await fetch(`${baseUrl}/api/directories?path=${encodeURIComponent("/no/such/dir")}`);
    assert.equal(bad.status, 400);
    const file = await fetch(`${baseUrl}/api/directories?path=${encodeURIComponent(`${repo}/package.json`)}`);
    assert.equal(file.status, 400);
  });
});

test("plugins registry endpoint serves the descriptor list", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/plugins`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      plugins?: Array<{ id: string; title: string; surfaces: unknown[] }>;
    };
    assert.ok(Array.isArray(body.plugins), "plugins must be an array");
    const ids = (body.plugins ?? []).map((p) => p.id);
    for (const expected of [
      "cache-stats",
      "todo",
      "artifacts",
      "subagent-checkpoints",
      "subagent-graph",
      "modes",
      "bubbly-spinner",
    ]) {
      assert.ok(ids.includes(expected), `plugin ${expected} must be registered`);
    }
  });
});

test("static root serves the built client", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await res.text();
    assert.match(html, /<div id="root">/);
    assert.match(html, /app\.js/);
  });
});

test("static serving returns 404 for unknown assets", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/no-such-asset.js`);
    assert.equal(res.status, 404);
  });
});

test("non-GET requests are rejected with 405", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/plugins`, { method: "POST" });
    assert.equal(res.status, 405);
  });
});

test("resolveStaticPath rejects traversal and accepts real paths", () => {
  const root = resolve("/tmp/some-dist");
  assert.equal(resolveStaticPath(root, "/"), `${root}/index.html`);
  assert.equal(resolveStaticPath(root, "/app.js"), `${root}/app.js`);
  assert.equal(resolveStaticPath(root, "/..%2f..%2fetc%2fpasswd"), null);
  assert.equal(resolveStaticPath(root, "/%2e%2e/secret"), null);
  assert.equal(resolveStaticPath(root, "/\0etc"), null);
  assert.equal(resolveStaticPath(root, "/a/../../etc/passwd"), null);
});

function fakeCore(id: string): SessionCore {
  const state: SessionStateLite = {
    sessionId: id,
    sessionFile: "",
    isStreaming: false,
    isBashRunning: false,
    isCompacting: false,
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
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

test("sessions endpoint lists registered live sessions", async () => {
  registerSession(fakeCore("route-session"), "/tmp/project");
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      sessions?: Array<{ id: string; cwd: string; live: boolean }>;
    };
    const entry = body.sessions?.find((session) => session.id === "route-session");
    assert.ok(entry, "registered session must be listed");
    assert.equal(entry.live, true);
    assert.equal(entry.cwd, "/tmp/project");
  });
});

test("prompt command round-trips through POST /api/agent/:id", async () => {
  const prompts: string[] = [];
  const core = fakeCore("prompt-session");
  registerSession(
    {
      ...core,
      prompt: async (text: string) => {
        prompts.push(text);
      },
    },
    "/tmp/project",
  );
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/agent/prompt-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prompt", message: "hello" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { success?: boolean; data?: { accepted?: boolean } };
    assert.equal(body.success, true);
    assert.deepEqual(body.data, { accepted: true });
    assert.deepEqual(prompts, ["hello"]);
  });
});

test("POST /api/agent/:id rejects malformed commands with 400", async () => {
  registerSession(fakeCore("bad-command"), "/tmp/project");
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/agent/bad-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "nonsense" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /unknown command type/);
  });
});

test("GET /api/agent/:id returns the projected state", async () => {
  registerSession(fakeCore("state-session"), "/tmp/project");
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/agent/state-session`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      running?: boolean;
      state?: { sessionId?: string; model?: { id: string } };
    };
    assert.equal(body.running, true);
    assert.equal(body.state?.sessionId, "state-session");
    assert.equal(body.state?.model?.id, "claude-sonnet-4-5");
  });
});

test("agent routes return 404 for unknown sessions", async () => {
  await withServer(async (baseUrl) => {
    const command = await fetch(`${baseUrl}/api/agent/never-seen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "get_state" }),
    });
    assert.equal(command.status, 404);

    const history = await fetch(`${baseUrl}/api/agent/never-seen/history`);
    assert.equal(history.status, 404);

    const state = await fetch(`${baseUrl}/api/agent/never-seen`);
    assert.equal(state.status, 404);
  });
});

test("the served shell carries the build id, and health reports the same one", async () => {
  // A temporary dist with a build record: the id the server reports must be the
  // one stamped into the HTML, or every page would reload on a loop.
  const dist = await mkdtemp(join(tmpdir(), "pi-web-build-"));
  try {
    await writeFile(join(dist, "index.html"), "<!doctype html><html><head></head><body></body></html>", "utf8");
    await writeFile(join(dist, "build.json"), JSON.stringify({ buildId: "abc123", builtAt: "t" }), "utf8");
    const handle = await startWebServer({ port: 0, host: "127.0.0.1", clientDist: dist });
    try {
      const baseUrl = `http://127.0.0.1:${handle.port}`;
      const health = (await (await fetch(`${baseUrl}/api/health`)).json()) as { buildId?: unknown };
      assert.equal(health.buildId, "abc123");

      const html = await (await fetch(`${baseUrl}/`)).text();
      assert.match(html, /<meta name="pi-web-build" content="abc123" \/>/);

      // An SPA route falls back to the same stamped shell.
      const route = await (await fetch(`${baseUrl}/plugins/todo`)).text();
      assert.match(route, /<meta name="pi-web-build" content="abc123" \/>/);
    } finally {
      await handle.close();
    }
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test("a server without a build record reports no build id and stamps nothing", async () => {
  const dist = await mkdtemp(join(tmpdir(), "pi-web-nobuild-"));
  try {
    await writeFile(join(dist, "index.html"), "<!doctype html><html><head></head><body></body></html>", "utf8");
    const handle = await startWebServer({ port: 0, host: "127.0.0.1", clientDist: dist });
    try {
      const baseUrl = `http://127.0.0.1:${handle.port}`;
      const health = (await (await fetch(`${baseUrl}/api/health`)).json()) as { buildId?: unknown };
      assert.equal(health.buildId, null);
      const html = await (await fetch(`${baseUrl}/`)).text();
      assert.doesNotMatch(html, /pi-web-build/);
    } finally {
      await handle.close();
    }
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test("a rebuild under a running server is announced so open pages converge", async () => {
  const dist = await mkdtemp(join(tmpdir(), "pi-web-rebuild-"));
  try {
    await writeFile(join(dist, "index.html"), "<!doctype html><html><head></head><body></body></html>", "utf8");
    await writeFile(join(dist, "build.json"), JSON.stringify({ buildId: "first", builtAt: "t" }), "utf8");
    const handle = await startWebServer({ port: 0, host: "127.0.0.1", clientDist: dist });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/events`);
      assert.ok(res.body !== null);
      const reader = res.body.getReader();
      const readUntil = createFrameReader(reader);
      await readUntil((text) => text.includes("sessions_snapshot"));

      // The build replaces the record on disk; the running server keeps serving.
      await writeFile(join(dist, "build.json"), JSON.stringify({ buildId: "second", builtAt: "t2" }), "utf8");
      const frame = await readUntil((text) => text.includes("\"type\":\"build_changed\""));
      assert.match(frame, /"buildId":"second"/);

      await reader.cancel();
    } finally {
      await handle.close();
    }
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});
