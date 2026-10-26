import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAutoCompact } from "../lib/vcc/controller.ts";
import type { AutoCompactConfig } from "../lib/vcc/config.ts";
import { resolveBudget } from "../lib/vcc/budget.ts";

const WINDOW = 32_000;
const filler = (n: number) => "detail ".repeat(n);

function entries() {
  return [
    { sourceEntry: { id: "sys", type: "message" }, messages: [{ role: "system", content: "system prompt ".repeat(100) }] },
    { sourceEntry: { id: "u1", type: "message" }, messages: [{ role: "user", content: `fix a.ts ${filler(4000)}` }] },
    {
      sourceEntry: { id: "a0", type: "message" },
      messages: [{ role: "assistant", content: [{ type: "toolCall", id: "t0", name: "read", arguments: { path: "src/a.ts" } }] }],
    },
    {
      sourceEntry: { id: "r0", type: "message" },
      messages: [{ role: "toolResult", toolCallId: "t0", toolName: "read", isError: false, content: [{ type: "text", text: "export function foo() {}" }] }],
    },
    { sourceEntry: { id: "a1", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: filler(6000) }] }] },
    { sourceEntry: { id: "u2", type: "message" }, messages: [{ role: "user", content: `keep memory low ${filler(4000)}` }] },
    {
      sourceEntry: { id: "a3", type: "message" },
      messages: [{
        role: "assistant",
        content: [
          { type: "toolCall", id: "t1", name: "bash", arguments: { command: "bun test" } },
          { type: "toolCall", id: "t2", name: "read", arguments: { path: "src/a.ts" } },
        ],
      }],
    },
    {
      sourceEntry: { id: "r1", type: "message" },
      messages: [{ role: "toolResult", toolCallId: "t1", toolName: "bash", isError: false, content: [{ type: "text", text: "12 passed, 0 failed" }] }],
    },
    {
      sourceEntry: { id: "r2", type: "message" },
      messages: [{ role: "toolResult", toolCallId: "t2", toolName: "read", isError: false, content: [{ type: "text", text: "export function foo() {}" }] }],
    },
  ];
}

const SUMMARY = [
  "[Session Goal]",
  "- Fix src/a.ts and keep memory low",
  "",
  "[Files And Changes]",
  "- Modified: src/a.ts",
].join("\n");

interface FixtureOptions {
  config?: AutoCompactConfig;
  tokens?: number;
  window?: number;
  usageUnknown?: boolean;
  compile?: () => Promise<string>;
}

function fixture(options: FixtureOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vcc-budget-"));
  const handlers: Record<string, any> = {};
  const pi = { on: (name: string, handler: any) => { handlers[name] = handler; } } as any;
  const ctxEntries = entries();
  let tokens: number | null = options.tokens ?? WINDOW;
  const window = options.window ?? WINDOW;
  if (options.usageUnknown) tokens = null;

  const controller = new AbortController();
  const ctx: any = {
    sessionManager: { getSessionId: () => "session-1", getLeafId: () => "r2" },
    model: { provider: "test", id: "model", contextWindow: window },
    signal: controller.signal,
    hasUI: false,
    ui: { setStatus() {}, notify() {} },
    getContextUsage: () => ({ tokens, contextWindow: window }),
    compact: () => { throw new Error("manual compact must not be called"); },
  };

  const calls: any[] = [];
  const compileSummary = async (input: any) => {
    calls.push(input);
    return options.compile ? options.compile() : SUMMARY;
  };

  registerAutoCompact(pi, {
    readConfig: () => options.config ?? { enabled: true, mode: "budgeted" },
    compileSummary: compileSummary as any,
    recallNote: "Use `vcc_recall` to search for prior work.",
    telemetryPath: join(dir, "telemetry.jsonl"),
  });

  const event = () => ({
    type: "turn_end",
    outcome: "completed",
    entries: [],
    continue: false,
    messageEntryId: "a3",
    toolResultEntryIds: ["r1", "r2"],
    turnIndex: 1,
    context: { contextEntries: ctxEntries, pendingMessages: [] },
  });

  const telemetry = () => {
    try {
      return readFileSync(join(dir, "telemetry.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };

  return {
    ctx, event, calls, telemetry, controller, handlers,
    setTokens: (value: number | null) => { tokens = value; },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("the budgeted trigger is the model budget, not 20% of the window", async () => {
  const f = fixture();
  const budget = resolveBudget({ contextWindow: WINDOW })!;

  f.setTokens(Math.floor(WINDOW * 0.2));
  assert.equal(await f.handlers.turn_end(f.event(), f.ctx), undefined);
  assert.equal(f.calls.length, 0, "20% is far below the quality target");

  f.setTokens(budget.qualityTarget - 1);
  assert.equal(await f.handlers.turn_end(f.event(), f.ctx), undefined);
  assert.equal(f.calls.length, 0);

  f.setTokens(budget.qualityTarget);
  const result = await f.handlers.turn_end(f.event(), f.ctx);
  assert.equal(f.calls.length, 1);
  assert.equal(result.entries.at(-1).type, "compaction");
  assert.equal(result.entries.at(-1).details.policy, "budgeted");
  assert.equal(result.entries.at(-1).details.compactor, "pi-vcc");
  assert.equal(result.entries.at(-1).details.budget.qualityTarget, budget.qualityTarget);
  f.dispose();
});

test("a summary is packed to the model's summary budget", async () => {
  const big = `[Session Goal]\n- fix a.ts\n\n---\n\n${Array.from({ length: 400 }, (_, i) => `[assistant]\n* read "f${i}.ts" (#${i})`).join("\n")}`;
  const f = fixture({ compile: async () => big });
  const budget = resolveBudget({ contextWindow: WINDOW })!;
  f.setTokens(budget.qualityTarget);
  const result = await f.handlers.turn_end(f.event(), f.ctx);
  assert.equal(result.entries.at(-1).type, "compaction");
  const details = result.entries.at(-1).details;
  assert.ok(details.summaryTokens <= budget.summaryBudget, `${details.summaryTokens} <= ${budget.summaryBudget}`);
  assert.ok(result.entries.at(-1).summary.length < big.length);
  f.dispose();
});

test("successful tool evidence survives compaction", async () => {
  const f = fixture();
  const budget = resolveBudget({ contextWindow: WINDOW })!;
  f.setTokens(budget.qualityTarget);
  const result = await f.handlers.turn_end(f.event(), f.ctx);
  const summary = result.entries.at(-1).summary;
  assert.match(summary, /\[Observed Evidence\]/);
  assert.match(summary, /export function foo/, "summarized observations keep their findings");
  assert.match(summary, /vcc_recall/);
  // The newest batch stays in the retained tail, so its results are still visible.
  assert.equal(result.entries.at(-1).firstKeptEntryId, "u2");
  f.dispose();
});

test("the compacted request is verified against capacity", async () => {
  const f = fixture();
  const budget = resolveBudget({ contextWindow: WINDOW })!;
  f.setTokens(budget.qualityTarget);
  const result = await f.handlers.turn_end(f.event(), f.ctx);
  const details = result.entries.at(-1).details;
  assert.ok(details.afterTokens <= budget.inputAllowance);
  assert.ok(details.afterTokens <= budget.qualityTarget);
  assert.equal(details.headroomSatisfied, true);
  assert.ok(f.telemetry().at(-1).outcome === "committed");
  f.dispose();
});

test("shadow mode plans, logs, and commits nothing", async () => {
  const f = fixture({ config: { enabled: true, mode: "budgeted", shadow: true } });
  const budget = resolveBudget({ contextWindow: WINDOW })!;
  f.setTokens(budget.qualityTarget);
  assert.equal(await f.handlers.turn_end(f.event(), f.ctx), undefined);
  const records = f.telemetry();
  assert.equal(records.at(-1).outcome, "shadow");
  assert.ok(records.at(-1).afterTokens > 0);
  f.dispose();
});

test("an unrepresentable protected summary is skipped, not truncated", async () => {
  const oversized = `[Session Goal]\n- ${"requirement ".repeat(4000)}`;
  const f = fixture({ compile: async () => oversized });
  const budget = resolveBudget({ contextWindow: WINDOW })!;
  f.setTokens(budget.qualityTarget);
  assert.equal(await f.handlers.turn_end(f.event(), f.ctx), undefined);
  assert.equal(f.calls.length, 1);
  const record = f.telemetry().at(-1);
  assert.equal(record.outcome, "skipped");
  assert.match(record.reason, /Protected summary/);
  // Back-off: the next three turns do not retry the compiler.
  await f.handlers.turn_end(f.event(), f.ctx);
  await f.handlers.turn_end(f.event(), f.ctx);
  await f.handlers.turn_end(f.event(), f.ctx);
  assert.equal(f.calls.length, 1);
  f.dispose();
});

test("legacy mode still compacts at maxPercent of the window", async () => {
  const f = fixture({ config: { enabled: true, mode: "legacy", maxPercent: 20 } });
  const budget = resolveBudget({ contextWindow: WINDOW })!;
  f.setTokens(Math.floor(WINDOW * 0.2));
  const result = await f.handlers.turn_end(f.event(), f.ctx);
  assert.equal(result.entries.at(-1).type, "compaction");
  assert.equal(result.entries.at(-1).details.thresholdPercent, 20);
  assert.equal(result.entries.at(-1).details.policy, undefined);
  assert.ok(budget.qualityTarget > Math.floor(WINDOW * 0.2));
  f.dispose();
});

test("failed turns, unknown usage, staged edits, and disabled config are ignored", async () => {
  const f = fixture();
  const budget = resolveBudget({ contextWindow: WINDOW })!;
  f.setTokens(budget.qualityTarget);

  const failed = f.event();
  failed.outcome = "error";
  assert.equal(await f.handlers.turn_end(failed, f.ctx), undefined);

  const staged = f.event();
  (staged as { entries: unknown[] }).entries = [
    { type: "context_edit", targetId: "u1", replacement: null },
  ];
  assert.equal(await f.handlers.turn_end(staged, f.ctx), undefined);

  f.setTokens(null);
  assert.equal(await f.handlers.turn_end(f.event(), f.ctx), undefined);
  assert.equal(f.calls.length, 0);

  const disabled = fixture({ config: { enabled: false, mode: "budgeted" } });
  disabled.setTokens(budget.qualityTarget);
  assert.equal(await disabled.handlers.turn_end(disabled.event(), disabled.ctx), undefined);
  assert.equal(disabled.calls.length, 0);
  f.dispose();
  disabled.dispose();
});

test("cancellation or a changed leaf during compilation commits nothing", async () => {
  const f = fixture({ compile: async () => { f.controller.abort(); return SUMMARY; } });
  const budget = resolveBudget({ contextWindow: WINDOW })!;
  f.setTokens(budget.qualityTarget);
  assert.equal(await f.handlers.turn_end(f.event(), f.ctx), undefined);
  f.dispose();
});

test("parallel tool results stay in the retained tail of the draft boundary", async () => {
  const f = fixture();
  const budget = resolveBudget({ contextWindow: WINDOW })!;
  f.setTokens(budget.qualityTarget);
  const result = await f.handlers.turn_end(f.event(), f.ctx);
  const firstKept = result.entries.at(-1).firstKeptEntryId;
  const keptIds = entries().map((entry) => entry.sourceEntry.id);
  const keptFrom = keptIds.indexOf(firstKept);
  assert.ok(keptFrom >= 0);
  for (const id of ["a3", "r1", "r2"]) {
    assert.ok(keptIds.indexOf(id) >= keptFrom, `${id} must stay in the retained tail`);
  }
  f.dispose();
});
