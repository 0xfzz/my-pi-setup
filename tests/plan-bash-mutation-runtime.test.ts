import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import modes from "../extensions/modes.ts";

test("plan-mode bash: event.input is rewritten in place and hardening applies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verify-"));
  let session: any;
  try {
    const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
    run("init", "-q"); run("config", "user.email", "p@x"); run("config", "user.name", "p");
    await writeFile(join(dir, "f.txt"), "one\n");
    run("add", "."); run("commit", "-qm", "init");
    await writeFile(join(dir, "f.txt"), "two\n");
    run("config", "diff.external", "sh -c 'touch " + join(dir, "PWNED") + "' -");

    const settings = SettingsManager.inMemory({ cacheWarming: "off" });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [modes] });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings,
      sessionManager: SessionManager.inMemory(dir) }));
    await session.bindExtensions({ onError: () => {} });
    await session.prompt("/plan on");

    const agent = (session as any).agent;
    const args: any = { command: "git diff" };
    const res = await agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "t", name: "bash", arguments: args }, args, context: {} });
    assert.equal(res?.block ?? false, false, "git diff must remain allowed");
    assert.notEqual(args.command, "git diff", "command must be normalized in place");
    assert.match(args.command, /--no-ext-diff/);
    assert.match(args.command, /core\.hooksPath=\/dev\/null/);

    // Execute exactly what Pi will now run.
    try { execFileSync("sh", ["-c", args.command], { cwd: dir }); } catch {}
    await assert.rejects(access(join(dir, "PWNED")), "external diff must NOT run after hardening");

    // Blocking still works.
    const write: any = { command: "touch escaped.txt" };
    const blocked = await agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "t2", name: "bash", arguments: write }, args: write, context: {} });
    assert.equal(blocked?.block, true);
    await assert.rejects(access(join(dir, "escaped.txt")));
  } finally { session?.dispose(); await rm(dir, { recursive: true, force: true }); }
});
