import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { startWebServer, resolveStaticPath } from "./main.ts";
import {
  clearSessionsForTests,
  registerSession,
  type SessionCore,
  type SessionStateLite,
} from "./sessions.ts";

test.afterEach(() => {
  clearSessionsForTests();
});

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
      "subagent-monitor",
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
