import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { publishWebView } from "../../../lib/web-plugins/publisher.ts";
import { createHeadlessWebUiContext } from "./web-ui-context.ts";
import { attachSessionPlugins, clearWebPluginStateForTests, webPluginsStore } from "./plugin-host.ts";

type ModelRef = NonNullable<CreateAgentSessionOptions["model"]>;

/** A model reference that is only stored on the session, never streamed against. */
const UNUSED_MODEL = {
  id: "web-test",
  name: "Web test",
  provider: "web-test",
  api: "web-test-scripted",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10000,
  maxTokens: 1000,
} as unknown as ModelRef;

/**
 * The in-process resume path (sessions.ts) must republish resting plugin views
 * the moment a session opens. This drives that exact sequence: one inline
 * extension publishes on session_start, bindExtensions emits session_start
 * headlessly, then the host attaches and replays the remembered value. The bug
 * this guards: views appearing only after a prompt because session_start never
 * fired for in-process sessions.
 */
test("in-process sessions republish resting views on session_start", async () => {
  clearWebPluginStateForTests();
  const dir = await mkdtemp(join(tmpdir(), "pi-web-session-start-"));

  try {
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    });

    const restingView = { type: "status", tone: "neutral", text: "resting-todo" } as const;

    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [(pi) => {
        pi.on("session_start", () => {
          publishWebView(pi, "todo", restingView);
        });
      }],
    });
    await loader.reload();

    const created = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager: SessionManager.create(dir, dir),
      model: UNUSED_MODEL,
    });
    const session = created.session;

    // sessions.ts binds this exact way before register()/attachSessionPlugins.
    await session.bindExtensions({ uiContext: createHeadlessWebUiContext() });

    const sessionId = session.sessionId;
    assert.ok(sessionId, "the in-memory session has an id");

    const detach = attachSessionPlugins({
      sessionId,
      inner: session,
      onEvent: (listener: (event: { type?: string }) => void) =>
        session.subscribe(listener as (event: unknown) => void),
    });

    assert.deepEqual(
      webPluginsStore.getView(sessionId, "todo"),
      restingView,
      "the resting view published on session_start must reach the store on attach",
    );

    detach();
    session.dispose();
  } finally {
    clearWebPluginStateForTests();
    await rm(dir, { recursive: true, force: true });
  }
});