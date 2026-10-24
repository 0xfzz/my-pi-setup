import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/smart-timeout.ts";
import {
  diagnose, formatBashCallWithTimeout, formatTimeoutStamp, smartOperations, validateConfig,
  type TimeoutReport,
} from "../lib/smart-timeout.ts";

const config = { defaultSeconds: 0.4, idleSeconds: 0.15, maxSeconds: 2 };
async function run(command: string, timeout?: number, signal?: AbortSignal) {
  let report: TimeoutReport | undefined;
  const tool = createBashToolDefinition(process.cwd(), {
    operations: smartOperations(createLocalBashOperations(), config, value => { report = value; }),
  });
  const result = await tool.execute("test", { command, timeout }, signal, undefined, {
    cwd: process.cwd(), sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
  } as any);
  const structured = result.structuredContent as { exit_code: number };
  return { result, structured, report, text: result.content.map(c => c.type === "text" ? c.text : "").join("\n") };
}

test("configuration rejects invalid, unknown and inconsistent limits", () => {
  assert.equal(validateConfig({}).defaultSeconds, 180);
  for (const value of [null, [], { maxSeconds: 0 }, { idleSeconds: NaN }, { defaultSeconds: 2000 }, { typo: 5 }, { maxSeconds: "100" }, { maxSeconds: 86401 }]) {
    assert.throws(() => validateConfig(value));
  }
});

test("normal success and nonzero exit retain built-in behavior", async () => {
  const ok = await run("printf hello");
  assert.equal(ok.text, "hello");
  assert.equal(ok.report, undefined);
  assert.equal(ok.structured.exit_code, 0);
  const fail = await run("printf failure; exit 3");
  assert.equal(fail.result.isError, true);
  assert.equal(fail.structured.exit_code, 3);
  assert.match(fail.text, /failure/);
});

test("silent command is killed with output, structured failure and inspect-first advice", async () => {
  const value = await run("printf before; sleep 10");
  assert.equal(value.report?.reason, "idle");
  assert.equal(value.report?.recommendation, "inspect-first");
  assert.equal(value.result.isError, true);
  assert.equal(value.structured.exit_code, 124);
  assert.match(value.text, /before/);
  assert.match(value.text, /partial side effects/);
});

test("continuous output cannot defeat hard wall deadline", async () => {
  const value = await run("while true; do echo working; sleep 0.02; done");
  assert.equal(value.report?.reason, "wall");
  assert.equal(value.report?.recommendation, "consider-increase");
  assert.match(value.text, /not proof of progress/);
});

test("explicit budget permits quiet work beyond default idle and wall limits", async () => {
  const value = await run("sleep 0.55; printf finished", 1.2);
  assert.equal(value.report, undefined);
  assert.match(value.text, /finished/);
});

test("explicit budget still terminates quiet hangs", async () => {
  const value = await run("sleep 10", 0.2);
  assert.equal(value.report?.reason, "wall");
});

test("invalid or over-ceiling explicit timeouts never execute", async () => {
  for (const timeout of [0, -1, Infinity, NaN, 3]) {
    await assert.rejects(run("printf should-not-run", timeout), /timeout must/);
  }
});

test("interactive and error evidence recommend fixes instead of larger budget", async () => {
  for (const command of ["printf 'Password:'; sleep 10", "printf 'fatal: broken'; sleep 10"]) {
    const value = await run(command);
    assert.equal(value.report?.recommendation, "fix-first");
  }
  const report = diagnose("npm run dev", "", { reason: "idle", elapsedSeconds: 90, silentSeconds: 90, limitSeconds: 90 }, 1800);
  assert.equal(report.recommendation, "fix-first");
});

test("cancellation remains an abort, not a timeout", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60);
  try { await assert.rejects(run("sleep 10", undefined, controller.signal), /Command aborted/); }
  finally { clearTimeout(timer); }
  await assert.rejects(run("echo never", undefined, AbortSignal.abort()), /Command aborted/);
});

test("parallel calls have independent silence clocks", async () => {
  const [idle, busy] = await Promise.all([
    run("sleep 10"),
    run("for i in 1 2 3 4 5 6; do echo tick; sleep 0.04; done"),
  ]);
  assert.equal(idle.report?.reason, "idle");
  assert.equal(busy.report, undefined);
});

test("timeout kills ordinary descendant processes (Linux)", { skip: process.platform !== "linux" }, async () => {
  const value = await run("sleep 10 & echo CHILD:$!; wait");
  const pid = Number(value.text.match(/CHILD:(\d+)/)?.[1]);
  assert.ok(pid > 0);
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    assert.match(status, /State:\s+Z/, "descendant must be gone or a terminated zombie awaiting reaping");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
});

test("formatTimeoutStamp and formatBashCallWithTimeout format explicit and default timeouts", () => {
  const conf = { defaultSeconds: 180, idleSeconds: 90, maxSeconds: 1800 };
  assert.equal(formatTimeoutStamp(undefined, conf), "(timeout: 180s, idle: 90s)");
  assert.equal(formatTimeoutStamp(30, conf), "(timeout: 30s)");
  assert.equal(formatTimeoutStamp(0.5, conf), "(timeout: 0.5s)");
  assert.equal(formatTimeoutStamp(-1, conf), "(timeout: 180s, idle: 90s)");

  const theme = {
    fg: (token: string, text: string) => `[${token}]${text}[/${token}]`,
    bold: (text: string) => `*${text}*`,
  };
  const stampedDefault = formatBashCallWithTimeout({ command: "git status" }, conf, theme);
  assert.match(stampedDefault, /git status/);
  assert.match(stampedDefault, /\(timeout: 180s, idle: 90s\)/);

  const stampedExplicit = formatBashCallWithTimeout({ command: "cargo test", timeout: 60 }, conf, theme);
  assert.match(stampedExplicit, /cargo test/);
  assert.match(stampedExplicit, /\(timeout: 60s\)/);
});

test("extension registers a compatible bash override, command and cleanup hooks", async () => {
  let tool: any;
  const hooks = new Map<string, Function>();
  const commands: string[] = [];
  extension({
    registerTool(value: any) { tool = value; },
    on(event: string, handler: Function) { hooks.set(event, handler); },
    registerCommand(name: string) { commands.push(name); },
  } as any);
  assert.equal(tool.name, "bash");
  assert.ok(tool.outputSchema);
  assert.equal(typeof tool.renderCall, "function");
  assert.ok(hooks.has("session_shutdown"));
  assert.deepEqual(commands, ["smart-timeout"]);

  // Test renderCall timeout stamping
  const mockTheme = {
    fg: (_token: string, text: string) => text,
    bold: (text: string) => text,
  };
  const defaultCallComp = tool.renderCall({ command: "git status" }, mockTheme, {});
  assert.match(defaultCallComp.render(120).join("\n"), /\(timeout: 180s, idle: 90s\)/);

  const explicitCallComp = tool.renderCall({ command: "npm test", timeout: 25 }, mockTheme, {});
  assert.match(explicitCallComp.render(120).join("\n"), /\(timeout: 25s\)/);

  const result = await tool.execute("integration", { command: "printf extension-ok" }, undefined, undefined, { cwd: process.cwd(), sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined } });
  assert.equal(result.structuredContent.exit_code, 0);
  assert.equal(result.content[0].text, "extension-ok");
  assert.equal(result.details.appliedTimeout.stamp, "(timeout: 180s, idle: 90s)");
  assert.equal(result.details.appliedTimeout.wallSeconds, 180);
  assert.equal(result.details.appliedTimeout.idleSeconds, 90);
  assert.equal(result.details.appliedTimeout.isExplicit, false);

  const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined } };
  const timedOut = await tool.execute("timeout-integration", { command: "printf retained; sleep 10", timeout: 0.15 }, undefined, undefined, ctx);
  assert.equal(timedOut.isError, true);
  assert.equal(timedOut.details.smartTimeout.reason, "wall");
  assert.equal(timedOut.details.appliedTimeout.stamp, "(timeout: 0.15s)");
  assert.equal(timedOut.details.appliedTimeout.wallSeconds, 0.15);
  assert.equal(timedOut.details.appliedTimeout.isExplicit, true);
  assert.equal(timedOut.structuredContent.exit_code, 124);
  assert.match(timedOut.content[0].text, /retained[\s\S]*smart-timeout/);
  const running = tool.execute("shutdown-integration", { command: "echo ready; sleep 10" }, undefined, (update: any) => {
    if (update.content.some((c: any) => c.text?.includes("ready"))) void hooks.get("session_shutdown")!();
  }, ctx);
  await assert.rejects(running, /Command aborted/);
  await hooks.get("session_shutdown")!();
});
