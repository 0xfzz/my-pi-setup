import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSubagentSession, recallSubagentHistory } from "../lib/vcc-subagent-adapter.ts";
import checkpoints from "../extensions/subagent-checkpoints.ts";
import { CHECKPOINT_TYPE, launched } from "../lib/subagent-state.ts";

function createChildSessionJsonl(cwd: string): string {
  const t0 = "2026-10-18T12:00:00.000Z";
  const t1 = "2026-10-18T12:00:01.000Z";
  const t2 = "2026-10-18T12:00:02.000Z";
  const t3 = "2026-10-18T12:00:03.000Z";
  const t4 = "2026-10-18T12:00:04.000Z";
  const t5 = "2026-10-18T12:00:05.000Z";

  const entries = [
    { type: "session", version: 3, id: "session-root", timestamp: t0, cwd },
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: t1,
      message: {
        role: "user",
        content: "Fix the user authentication token bug and write tests",
        timestamp: 1000,
      },
    },
    {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: t2,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect the auth controller and test files." },
          { type: "toolCall", id: "tc1", name: "read", arguments: { path: "src/auth.ts" } },
        ],
        timestamp: 2000,
      },
    },
    {
      type: "message",
      id: "m3",
      parentId: "m2",
      timestamp: t3,
      message: {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "read",
        content: [{ type: "text", text: "export function verifyToken(t: string) { return t === 'secret'; }" }],
        isError: false,
        timestamp: 3000,
      },
    },
    {
      type: "message",
      id: "m4",
      parentId: "m3",
      timestamp: t4,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Now running test suite with bash." },
          { type: "toolCall", id: "tc2", name: "bash", arguments: { command: "npm test" } },
        ],
        timestamp: 4000,
      },
    },
    {
      type: "message",
      id: "m5",
      parentId: "m4",
      timestamp: t5,
      message: {
        role: "toolResult",
        toolCallId: "tc2",
        toolName: "bash",
        content: [{ type: "text", text: "FAIL tests/auth.test.ts: TokenExpiredError: jwt expired" }],
        isError: true,
        timestamp: 5000,
      },
    },
  ];

  return entries.map((e) => JSON.stringify(e)).join("\n");
}

test("compileSubagentSession produces structured VCC sections from child session branch", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "pi-vcc-subagent-"));
  try {
    const sessionFile = join(tmp, "child.jsonl");
    await writeFile(sessionFile, createChildSessionJsonl(tmp), "utf8");

    const vccBrief = await compileSubagentSession(sessionFile);
    assert.ok(vccBrief, "VCC brief was generated");
    assert.match(vccBrief, /\[Session Goal\]|Fix the user authentication/);
    assert.match(vccBrief, /\[Brief Transcript\]|read|bash/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("recallSubagentHistory searches child session and expands specific entry indices", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "pi-vcc-subagent-"));
  try {
    const sessionFile = join(tmp, "child.jsonl");
    await writeFile(sessionFile, createChildSessionJsonl(tmp), "utf8");

    // Search for "jwt expired"
    const searchRes = await recallSubagentHistory({
      sessionFile,
      query: "TokenExpiredError|jwt",
    });

    assert.ok(searchRes.count >= 1);
    assert.match(searchRes.output, /TokenExpiredError/);
    assert.match(searchRes.output, /Child session matches/);

    // Expand the specific entry index (the toolResult entry)
    const expandRes = await recallSubagentHistory({
      sessionFile,
      expand: [4], // index of toolResult m5
    });

    assert.equal(expandRes.count, 1);
    assert.match(expandRes.output, /FAIL tests\/auth\.test\.ts/);
    assert.match(expandRes.output, /TokenExpiredError: jwt expired/);

    // Expanding invalid index throws
    await assert.rejects(async () => {
      await recallSubagentHistory({
        sessionFile,
        expand: [999],
      });
    }, /Cannot expand indices outside child session/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("subagent_history tool supports vccSummary, query, and expand parameters", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "pi-vcc-subagent-"));
  try {
    const sessionFile = join(tmp, "child.jsonl");
    await writeFile(sessionFile, createChildSessionJsonl(tmp), "utf8");

    const handlers = new Map<string, Function[]>();
    const tools = new Map<string, any>();
    const entries: any[] = [];

    const pi: any = {
      on(name: string, fn: Function) {
        handlers.set(name, [...handlers.get(name) ?? [], fn]);
      },
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      appendEntry(customType: string, data: any) {
        entries.push({ type: "custom", customType, data, timestamp: new Date().toISOString() });
      },
    };

    const context: any = {
      hasUI: false,
      sessionManager: { getBranch: () => entries },
      ui: { setWidget() {}, notify() {} },
    };

    checkpoints(pi);

    // Record the launch on the active branch
    const childRecord = launched({
      status: "started",
      id: "child-run-1",
      name: "AuthWorker",
      sessionFile,
      task: "Fix auth token bug",
    })!;
    entries.push({ type: "custom", customType: CHECKPOINT_TYPE, data: childRecord });

    const tool = tools.get("subagent_history");
    assert.ok(tool, "subagent_history tool is registered");

    // 1. vccSummary request
    const vccSummaryRes = await tool.execute("c1", {
      sessionPath: sessionFile,
      vccSummary: true,
    }, undefined, undefined, context);

    assert.equal(vccSummaryRes.details.mode, "vccSummary");
    assert.match(vccSummaryRes.content[0].text, /VCC Algorithmic Brief for \[AuthWorker\]/);

    // 2. query request
    const queryRes = await tool.execute("c2", {
      sessionPath: sessionFile,
      query: "jwt",
    }, undefined, undefined, context);

    assert.ok(queryRes.details.count >= 1);
    assert.match(queryRes.content[0].text, /Child session matches/);

    // 3. expand request
    const expandRes = await tool.execute("c3", {
      sessionPath: sessionFile,
      expand: [4],
    }, undefined, undefined, context);

    assert.equal(expandRes.details.count, 1);
    assert.match(expandRes.content[0].text, /FAIL tests\/auth\.test\.ts/);

    for (const fn of handlers.get("session_shutdown") ?? []) {
      await fn({}, context);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
