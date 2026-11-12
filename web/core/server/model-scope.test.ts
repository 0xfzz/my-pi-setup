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
} from "@earendil-works/pi-coding-agent";
import { applyEnabledModelScope } from "./sessions.ts";

/**
 * The web picker must offer the same model list as the TUI, which resolves the
 * `enabledModels` scope into `scopedModels` before serving a session. The
 * in-process runner used to skip that resolution, so a session opened in the
 * web (no TUI) fell back to the full available snapshot and diverged from the
 * same session opened through the TUI. This locks the resolution in.
 */
async function makeScopedSession(enabledModels: string[] | undefined) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-model-scope-"));

  const settings = SettingsManager.inMemory({
    ...(enabledModels !== undefined ? { enabledModels } : {}),
    // Kept empty on purpose: the scope must survive an absent default too.
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });

  // Register one real provider whose only model matches `web-test/*`. The
  // scope resolver only sees models whose provider reports configured auth,
  // which the literal apiKey provides.
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.registerProvider("web-test", {
          baseUrl: "http://127.0.0.1:1",
          apiKey: "web-test-key",
          api: "openai-responses",
          models: [
            {
              id: "web-test",
              name: "Web test",
              input: ["text"],
              reasoning: false,
              contextWindow: 10_000,
              maxTokens: 1_000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        });
      },
    ],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: SessionManager.create(dir, dir),
  });

  return { dir, session };
}

test("applyEnabledModelScope resolves enabledModels into the picker scope", async () => {
  const { dir, session } = await makeScopedSession(["web-test/*"]);
  try {
    await applyEnabledModelScope(session);
    assert.deepEqual(
      session.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`),
      ["web-test/web-test"],
      "the enabledModels scope must resolve to the matching available model",
    );
  } finally {
    session.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyEnabledModelScope leaves the scope empty when enabledModels is unset", async () => {
  const { dir, session } = await makeScopedSession(undefined);
  try {
    await applyEnabledModelScope(session);
    assert.equal(
      session.scopedModels.length,
      0,
      "no enabledModels scope must mean no scoped restriction (full snapshot fallback)",
    );
  } finally {
    session.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});