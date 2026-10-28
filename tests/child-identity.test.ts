import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import askUser from "../extensions/ask-user.ts";
import checkpoints from "../extensions/subagent-checkpoints.ts";
import {
  argvSessionFile, childContextState, isSubagentChildProcess, isSubagentChildSession,
} from "../lib/subagent-context.ts";

/**
 * Starting a plain `pi` used to make it believe it was a subagent.
 *
 * `PI_SUBAGENT_SESSION` is exported into a Herdr child's environment, and that
 * environment is inherited by anything started from there — a `pi` run inside a
 * child's shell, a nested agent, a script. Nothing ever cleared it, so a brand new
 * session with its own session file was treated as the child named by a foreign
 * env var: it lost its sidebar and `/provider`, refused to ask the user and told
 * the model to answer "the parent" instead, took the child artifact path, and
 * registered the child progress tool for a run id that was not its own.
 *
 * A real child is always launched as `pi --session <its own file>` (both the
 * launch and resume paths in pi-herdr-subagents), so the env var alone is not
 * evidence. These tests pin that contract: identity needs the matching session.
 */

// ── Unit: the predicate itself ──────────────────────────────────────────────

test("argvSessionFile reads both spellings of --session and nothing else", () => {
  assert.equal(argvSessionFile(["node", "pi", "--session", "/s/child.jsonl"]), "/s/child.jsonl");
  assert.equal(argvSessionFile(["node", "pi", "--session=/s/child.jsonl"]), "/s/child.jsonl");
  // A following flag must not be swallowed as the path.
  assert.equal(argvSessionFile(["node", "pi", "--session", "--tools", "read"]), undefined);
  assert.equal(argvSessionFile(["node", "pi", "--continue"]), undefined);
  assert.equal(argvSessionFile([]), undefined);
});

test("no PI_SUBAGENT_SESSION means not a child", () => {
  assert.equal(isSubagentChildProcess({ env: {}, argv: [] }), false);
  assert.equal(isSubagentChildSession({ sessionManager: { getSessionFile: () => "/s/any.jsonl" } }), false);
});

test("a child is the process whose own session file is the one the env names", () => {
  const env = { PI_SUBAGENT_SESSION: "/s/child.jsonl" };
  assert.equal(isSubagentChildProcess({ env, sessionFile: "/s/child.jsonl" }), true);
  assert.equal(isSubagentChildProcess({ env, argv: ["node", "pi", "--session", "/s/child.jsonl"] }), true);
  // Real paths are compared, so a symlinked alias still counts.
  assert.equal(isSubagentChildProcess({ env, argv: ["node", "pi", "--session=/s/child.jsonl"] }), true);
});

test("THE BUG: an inherited env var for another session is not a child", () => {
  const env = { PI_SUBAGENT_SESSION: "/s/old-child.jsonl" };
  // A fresh session with its own file, started from a child's shell.
  assert.equal(isSubagentChildProcess({ env, sessionFile: "/s/brand-new.jsonl" }), false);
  assert.equal(isSubagentChildProcess({ env, argv: ["node", "pi"] }), false);
  assert.equal(isSubagentChildProcess({ env, argv: ["node", "pi", "--session", "/s/brand-new.jsonl"] }), false);
});

test("identity needs positive evidence at every stage, including load time", () => {
  const env = { PI_SUBAGENT_SESSION: "/s/child.jsonl" };
  // At extension load there is no context, so argv is the only evidence; a real
  // child always has --session. This is what stops a plain `pi` from registering
  // child-only tools such as agent_progress.
  assert.equal(isSubagentChildProcess({ env, argv: ["node", "pi"] }), false);
  assert.equal(isSubagentChildProcess({ env, argv: ["node", "pi", "--session", "/s/child.jsonl"] }), true);
  // No session file at all cannot be a Herdr child either, because Herdr passes
  // --session unconditionally — this covers `pi --no-session`, whose own
  // getSessionFile() is undefined.
  assert.equal(isSubagentChildProcess({ env, sessionFile: undefined, argv: ["node", "pi"] }), false);
  assert.equal(isSubagentChildSession({ sessionManager: { getSessionFile: () => undefined } }), false);
});

test("a real child that changes its own session stays a child", () => {
  const claimed = "/s/child.jsonl";
  const env = { PI_SUBAGENT_SESSION: claimed };
  const argv = ["node", "pi", "--session", claimed];
  // The child is launched at child.jsonl, so it is a child.
  assert.equal(isSubagentChildProcess({ env, argv, sessionFile: claimed }), true);
  // It then runs `/new` or `/fork`, so the session it is ON is a different file,
  // while the process it IS remains the same Herdr child. Comparing the current
  // file would have flipped it to "not a child" mid-life and opened user UI in a
  // pane nobody is watching — the launch argument is the stable evidence.
  assert.equal(
    isSubagentChildProcess({ env, argv, sessionFile: "/s/child-new.jsonl" }),
    true,
    "moving to a new session must not revoke an already-proven child identity",
  );
  // Same thing through the context-based helper, which reads the *process's*
  // launch arguments: a real child's argv still carries its original --session
  // after /new, so identity survives.
  const savedEnv = process.env.PI_SUBAGENT_SESSION;
  const savedArgv = process.argv;
  try {
    process.env.PI_SUBAGENT_SESSION = claimed;
    process.argv = ["node", "pi", "--session", claimed];
    assert.equal(
      isSubagentChildSession({ sessionManager: { getSessionFile: () => "/s/child-new.jsonl" } }),
      true,
    );
  } finally {
    if (savedEnv === undefined) delete process.env.PI_SUBAGENT_SESSION;
    else process.env.PI_SUBAGENT_SESSION = savedEnv;
    process.argv = savedArgv;
  }
});

test("seeded isolation cannot be switched on by an inherited env var", () => {
  const parentSession = "/s/parent.jsonl";
  // Legacy seed: a copied parent branch with a parentSession header but no marker.
  const branch = [{ type: "session", id: "child" }, { type: "message", id: "p1", parentId: null }];
  const header = { parentSession };
  const stale = { PI_SUBAGENT_SESSION: "/s/old-child.jsonl" };
  // Proven not to be the child the env names: the parent's work must not be
  // treated as inherited by this session.
  const verified = isSubagentChildProcess({ env: stale, sessionFile: "/s/brand-new.jsonl" });
  assert.equal(childContextState(branch, header, verified).seeded, false);
  // The genuine child still isolates.
  const genuine = isSubagentChildProcess({ env: stale, sessionFile: "/s/old-child.jsonl" });
  assert.equal(childContextState(branch, header, genuine).seeded, true);
});

// ── End to end: a real session, driven by real Pi ───────────────────────────

const MODEL: any = {
  id: "child-identity", name: "Child identity", provider: "child-identity", api: "child-identity-scripted",
  baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"],
  contextWindow: 100000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** Boot a real session under a given environment and record what it was told. */
async function boot(opts: { env: Record<string, string>; argv: string[]; sessionFile?: string }) {
  const dir = await mkdtemp(join(tmpdir(), "pi-child-identity-"));
  const savedEnv = { ...process.env };
  const savedArgv = process.argv;
  for (const key of Object.keys(savedEnv)) {
    if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
  }
  Object.assign(process.env, opts.env);
  process.argv = ["node", "pi", ...opts.argv];

  const settings = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
  });
  const captured: string[] = [];
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [askUser, checkpoints, pi => {
      pi.registerProvider(MODEL.provider, {
        api: MODEL.api, baseUrl: MODEL.baseUrl, apiKey: "local-test-not-a-secret", models: [MODEL],
        streamSimple: (_m: any, context: any) => {
          captured.push(JSON.stringify(context.messages));
          const message: any = {
            role: "assistant", api: MODEL.api, provider: MODEL.provider, model: MODEL.id, timestamp: Date.now(),
            content: [{ type: "text", text: "ok" }], stopReason: "stop",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
          return stream;
        },
      });
    }],
  });
  await loader.reload();

  try {
    const created = await createAgentSession({
      cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings,
      sessionManager: opts.sessionFile
        ? SessionManager.open(opts.sessionFile, dir, dir)
        : SessionManager.create(dir, dir),
      model: MODEL,
    });
    await created.session.bindExtensions({ onError: (error: unknown) => console.log("extension error", error) });
    const sessionFile = created.session.sessionManager.getSessionFile();
    await created.session.prompt("just a normal question");
    const request = captured.at(-1) ?? "";
    return {
      sessionFile,
      request,
      childGuidance: request.includes("In a Herdr child"),
      parentRecall: created.session.getActiveToolNames().includes("agent_parent_recall"),
      progressTool: created.session.getActiveToolNames().includes("agent_progress"),
      dispose: () => created.session.dispose(),
    };
  } finally {
    process.env = savedEnv;
    process.argv = savedArgv;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test("REGRESSION: starting pi from a subagent's environment is a normal session", async () => {
  const booted = await boot({
    env: {
      PI_SUBAGENT_SESSION: "/nonexistent/old-child.jsonl",
      PI_SUBAGENT_ID: "stale-run",
      PI_SUBAGENT_NAME: "Worker",
      PI_SUBAGENT_PARENT: "/nonexistent/old-parent.jsonl",
    },
    argv: [],
  });
  try {
    // Its own session, not the one the environment claims.
    assert.ok(booted.sessionFile?.endsWith(".jsonl"));
    assert.notEqual(booted.sessionFile, "/nonexistent/old-child.jsonl");
    // No child protocol was imposed on it.
    assert.equal(booted.childGuidance, false, "a normal start must not be told it is a Herdr child");
    assert.equal(booted.parentRecall, false, "a normal start must not be given the parent-pull tool");
    assert.equal(booted.progressTool, false, "a normal start must not publish milestones to someone else's run");
  } finally { booted.dispose(); }
});

test("a genuine Herdr child still gets its child protocol", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-true-child-"));
  const parentFile = join(dir, "parent.jsonl");
  const childFile = join(dir, "child.jsonl");
  await writeFile(parentFile, [
    { type: "session", version: 3, id: "parent-id", cwd: dir },
    { type: "message", id: "p1", parentId: null,
      message: { role: "user", content: [{ type: "text", text: "Pick a library." }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await writeFile(childFile, [
    { type: "session", version: 3, id: "child-id", cwd: dir, parentSession: parentFile },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const booted = await boot({
    env: { PI_SUBAGENT_SESSION: childFile, PI_SUBAGENT_ID: "real-run", PI_SUBAGENT_PARENT: parentFile },
    argv: ["--session", childFile],
    sessionFile: childFile,
  });
  try {
    assert.equal(booted.sessionFile, childFile);
    assert.equal(booted.childGuidance, true, "a real child must still be told it is a child");
    assert.equal(booted.parentRecall, true, "a real child must still reach its parent");
  } finally { booted.dispose(); await rm(dir, { recursive: true, force: true }); }
});
