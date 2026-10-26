/**
 * End-to-end: a real Pi runtime, the real modes extension, the real dashboard
 * extension, the real detached server, and the real HTTP browser API.
 *
 * Every other dashboard test stubs at least one of those boundaries. This one
 * stubs none of them, which is the only way to catch the class of defect that
 * lives *between* the pieces: a mode notice that never reaches the bridge, a
 * producer that starts but never publishes, a server that answers the producer
 * yet rejects the browser, or a shutdown that leaves a detached process behind.
 *
 * Deliberately excluded: any orchestrator child spawn. That path needs Herdr
 * panes, and it is covered by the orchestrator suite; here the dashboard must be
 * correct for a session that has not delegated anything yet, which is exactly
 * the state the first snapshot is published in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import dashboardExtension from "../extensions/dashboard.ts";
import modesExtension from "../extensions/modes.ts";
import {
  readDashboardAddress,
  stopDashboardByRuntimeDir,
  type DashboardAddress,
} from "../lib/dashboard/lifecycle.ts";

interface Browser {
  listSessions(): Promise<any[]>;
  getSession(id: string): Promise<any>;
}

/** Bootstrap like a browser does: exchange the URL token for the HttpOnly cookie. */
async function openBrowser(browserUrl: string): Promise<Browser> {
  const bootstrap = await fetch(browserUrl, { redirect: "manual" });
  assert.equal(bootstrap.status, 302, "bootstrap must redirect, not render");
  const setCookie = bootstrap.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0]!;
  assert.match(cookie, /^pi_dashboard=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const root = new URL(browserUrl);
  const base = `${root.origin}/`;
  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`, { headers: { cookie } });
    return response;
  };
  return {
    async listSessions() {
      const response = await get("api/sessions");
      assert.equal(response.status, 200, `api/sessions failed: ${response.status}`);
      return ((await response.json()) as any).sessions as any[];
    },
    async getSession(id: string) {
      const response = await get(`api/session?id=${encodeURIComponent(id)}`);
      assert.equal(response.status, 200, `api/session failed: ${response.status}`);
      return ((await response.json()) as any).session;
    },
  };
}

/** Poll a condition without pinning the test to a specific publication order. */
async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  }
  throw new Error(`condition not met within ${timeoutMs}ms${lastError ? `: ${String(lastError)}` : ""}`);
}

test("real Pi entering Orchestrator mode serves the session to a real browser API", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-dashboard-e2e-"));
  const runtimeDir = join(dir, "runtime");
  let session: any;
  let address: DashboardAddress | null = null;
  const errors: unknown[] = [];
  const notices: string[] = [];
  const model: any = {
    id: "dashboard-e2e", name: "Dashboard e2e", provider: "dashboard-e2e-test", api: "dashboard-scripted",
    baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };

  try {
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
    });
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        modesExtension,
        // The dashboard gets a private runtime directory and a coalescing window
        // small enough that the assertion does not race the 100ms default.
        (pi: any) => dashboardExtension(pi, { runtimeDir, coalesceMs: 0, heartbeatMs: 0 }),
        (pi: any) => {
          pi.registerProvider("dashboard-e2e-test", {
            api: model.api, baseUrl: model.baseUrl, apiKey: "local-test", models: [model],
            streamSimple: () => {
              const message: any = {
                role: "assistant", api: model.api, provider: model.provider, model: model.id,
                timestamp: Date.now(), content: [{ type: "text", text: "fixture" }], stopReason: "stop",
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              };
              const stream = createAssistantMessageEventStream();
              stream.push({ type: "start", partial: message });
              stream.push({ type: "done", reason: "stop", message });
              return stream;
            },
          });
        },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, [], "both extensions must load cleanly");

    const manager = SessionManager.create(dir, dir);
    ({ session } = await createAgentSession({
      cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: manager, model,
    }));
    // Mode switching is a terminal-UI feature in Pi (`/mode` refuses elsewhere),
    // so this harness must present itself as a TUI or the transition under test
    // never happens — and a print-mode refusal would be indistinguishable from a
    // dashboard that failed to register.
    await session.bindExtensions({
      mode: "tui",
      onError: (error: unknown) => errors.push(error),
      uiContext: { setWidget() {}, setEditorComponent() {}, setStatus() {}, addAutocompleteProvider() {},
        notify(text: string) { notices.push(text); } } as any,
    });

    // Loading alone must not start anything: the server is created by the mode
    // transition, not by process startup or extension load.
    assert.equal(await readDashboardAddress(runtimeDir), null, "no server may exist before Orchestrator mode");

    await session.prompt("/mode orchestrator");
    // The producer starts asynchronously: the notice arrives once the detached
    // server answers its authenticated health check, not when the mode transition
    // returns. Asserting synchronously here would test the scheduler, not the URL.
    const urlNotice = await until(async () => notices.find(line => /Dashboard: http:\/\/127\.0\.0\.1:\d+\//.test(line)));
    assert.ok(urlNotice, "Pi must surface the dashboard URL");

    const browser = await until(async () => {
      const hint = await readDashboardAddress(runtimeDir);
      if (hint === null) return undefined;
      address = hint;
      return openBrowser(hint.browserUrl);
    });

    const sessions = await until(async () => {
      const list = await browser.listSessions();
      const match = list.find(entry => entry.mode === "orchestrator");
      return match ? list : undefined;
    });
    const entry = sessions.find(candidate => candidate.mode === "orchestrator")!;
    assert.equal(entry.connected, true, "the live parent must be reported connected");
    assert.equal(entry.project, dir.split("/").pop(), "project is the working directory name, not a path");
    assert.deepEqual(entry.workers, { running: 0, total: 0 }, "sessions are visible before the first spawn");

    // The first snapshot is complete: no artifact or child data is deferred to a
    // later mutation for the dashboard to look correct.
    const view = await browser.getSession(entry.id);
    assert.equal(view.session.mode, "orchestrator");
    assert.deepEqual(view.orchestrator.children, []);
    assert.deepEqual(view.orchestrator.handoffs, []);
    assert.deepEqual(view.orchestrator.escalations, []);
    assert.deepEqual(view.artifacts, [], "an empty catalog is published, not omitted");
    assert.equal(view.connected, true);
    // The dashboard must never receive the session file path, the producer token,
    // or a raw transcript.
    const serialized = JSON.stringify({ sessions, view });
    assert.doesNotMatch(serialized, /sessionFile|lastTail|producerToken|\.jsonl/);
    assert.doesNotMatch(serialized, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // Leaving the mode keeps the observation and publishes the real mode, rather
    // than deleting the session from the sidebar.
    await session.prompt("/mode normal");
    const left = await until(async () => {
      const list = await browser.listSessions();
      const match = list.find(candidate => candidate.id === entry.id);
      return match && match.mode === "normal" ? match : undefined;
    });
    assert.equal(left.connected, true, "leaving Orchestrator mode is not a disconnect");

    // Re-entering must reuse the same lease and the same session id — no duplicate
    // sidebar entry for one Pi process.
    await session.prompt("/mode orchestrator");
    const reentered = await until(async () => {
      const list = await browser.listSessions();
      const matches = list.filter(candidate => candidate.id === entry.id);
      return matches.length === 1 && matches[0].mode === "orchestrator" ? matches : undefined;
    });
    assert.equal(reentered.length, 1);
    assert.deepEqual(errors, [], "no extension error may be raised by the dashboard");
  } finally {
    try {
      await session?.extensionRunner?.emit?.({ type: "session_shutdown", reason: "quit" });
    } catch {
      // A shutdown hook failure must not mask the assertion that already failed.
    }
    session?.dispose?.();
    await stopDashboardByRuntimeDir(runtimeDir, { timeoutMs: 3_000 }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
