/**
 * Child failure handling and the mechanical result receipt.
 * The error strings are copied from real ~/.pi/agent/sessions transcripts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyChildError, isHaltedPing, parseRetryAfterMs } from "../../lib/delegation/child-error.ts";
import { errorIsTerminal, readChildHealth } from "../../lib/delegation/child-health.ts";
import { checkResult, criterionMentioned, roundOfHandoff, unresolvedBlockers } from "../../lib/delegation/result-check.ts";
import { retryDelayMs as autoResumeDelayMs } from "../../lib/delegation/recovery.ts";
import { artifactSidecarPath } from "../../lib/artifact-state.ts";
import agentExtension, { autoResumeSeams, registry } from "../../extensions/agent.ts";
import type { ScopedChild } from "../../lib/delegation/scope-registry.ts";

describe("classifyChildError", () => {
  const cases: Array<[string, string]> = [
    ['429: {"type":"server_error","message":"Upstream request failed: [ttft_admission_refused] the cell is at capacity; retry shortly (after 18 s)"}', "transient"],
    ["Connection error.", "transient"],
    ["fetch failed", "transient"],
    ["no response headers within 30000ms", "transient"],
    ['429: {"message":"Per-minute rate limit reached — slow down a bit.","type":"rate_limit_exceeded"}', "transient"],
    ["Codex error: The usage limit has been reached", "quota"],
    ["Quota reached. Please wait 2h5m3s. Next: switch models or try again after reset.", "quota"],
    ['429: {"message":"Hourly rate limit reached — come back in a little while.","type":"rate_limit_exceeded"}', "quota"],
    ["You have hit your ChatGPT usage limit (plus plan). Try again in ~30 min.", "quota"],
    ["Invalid Antigravity credentials. Run /login antigravity.", "auth"],
    ['provider "tokenharbor" is not registered', "config"],
    ["This operation was aborted", "aborted"],
    ["something nobody has seen", "unknown"],
  ];
  for (const [message, expected] of cases) {
    it(`${expected}: ${message.slice(0, 50)}`, () => assert.equal(classifyChildError(message).class, expected));
  }

  it("a silent endpoint is a stall; a busy endpoint is not", () => {
    assert.equal(classifyChildError("no response headers within 180000ms").stalled, true);
    assert.equal(classifyChildError("fetch failed").stalled, true);
    assert.equal(classifyChildError("Connection error.").stalled, true);
    assert.equal(classifyChildError("429 rate limit exceeded, retry in 20s").stalled, false);
    assert.equal(classifyChildError("usage limit reached").stalled, false);
  });

  it("only transient failures are retryable", () => {
    assert.equal(classifyChildError("Connection error.").retryable, true);
    assert.equal(classifyChildError("Codex error: The usage limit has been reached").retryable, false);
  });

  it("reads the provider's wait", () => {
    assert.equal(parseRetryAfterMs("retry shortly (after 18 s)"), 18_000);
    assert.equal(parseRetryAfterMs("Please wait 2h5m3s."), (2 * 3600 + 5 * 60 + 3) * 1000);
    assert.equal(parseRetryAfterMs("nothing here"), undefined);
  });

  it("recognises the child's halted ping", () => {
    assert.equal(isHaltedPing("Subagent halted: model limit or fatal error reached: x"), true);
    assert.equal(isHaltedPing("Which API version should I use?"), false);
  });
});

function session(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "child-health-"));
  const file = join(dir, "child.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}
const assistant = (content: unknown[], extra: object = {}, timestamp = "2026-01-01T00:00:00.000Z") =>
  ({ type: "message", timestamp, message: { role: "assistant", content, ...extra } });

describe("child health", () => {
  it("sees a trailing provider error and classifies it", () => {
    const file = session([assistant([], { stopReason: "error", errorMessage: "Codex error: The usage limit has been reached" })]);
    const health = readChildHealth(file);
    assert.equal(health.error?.verdict.class, "quota");
  });

  it("does not report an error the run has moved past", () => {
    const file = session([
      assistant([], { stopReason: "error", errorMessage: "Connection error." }),
      { type: "message", message: { role: "user", content: [] } },
      assistant([{ type: "text", text: "ok" }], { stopReason: "stop" }),
    ]);
    assert.equal(readChildHealth(file).error, undefined);
  });

  it("an error is terminal only after it outlives the retry window", () => {
    const file = session([assistant([], { stopReason: "error", errorMessage: "429 retry shortly (after 60 s)" })]);
    const health = readChildHealth(file);
    const base = Math.max(health.error!.at ?? 0, health.lastActivityAt ?? 0);
    assert.equal(errorIsTerminal(health, base + 30_000, { graceMs: 120_000 }), false);
    assert.equal(errorIsTerminal(health, base + 121_000, { graceMs: 120_000 }), true);
  });

  it("an aborted run is never terminal here", () => {
    const file = session([assistant([], { stopReason: "error", errorMessage: "This operation was aborted" })]);
    assert.equal(errorIsTerminal(readChildHealth(file), Date.now() + 3_600_000, { graceMs: 1 }), false);
  });
});

describe("result receipt", () => {
  function child(opts: { report?: string; calls?: unknown[]; lane?: string[]; outcome?: "completed" | "completed-user-exit" | "failed" }) {
    const file = session([assistant(opts.calls ?? [], { stopReason: "stop" })]);
    if (opts.report !== undefined) {
      writeFileSync(artifactSidecarPath(file, "report-api-1"), JSON.stringify({ id: "report-api-1", content: opts.report }));
    }
    return checkResult({
      sessionFile: file,
      scope: "api",
      handoffId: "handoff-api-1",
      laneFiles: opts.lane ?? ["src/api/"],
      frozenCriteria: ["retry budget is configurable", "errors are logged"],
      cwd: "/repo",
      outcome: opts.outcome ?? "completed",
    });
  }
  const call = (name: string, args: object) => ({ type: "toolCall", id: "x", name, arguments: args });

  it("a clean result has no issues", () => {
    const receipt = child({
      report: "The retry budget is configurable (src/api/retry.ts:4). Errors are logged via logger.",
      calls: [call("artifact_recall", { id: "handoff-api-1" }), call("edit", { path: "src/api/retry.ts" })],
    });
    assert.deepEqual(receipt.issues, []);
  });

  it("a non-code child (no lane, report only) is clean and needs no workspace write", () => {
    const receipt = child({
      lane: [],
      report: "The retry budget is configurable (see source 2). Errors are logged; limits stated in section 4.",
      calls: [call("artifact_recall", { id: "handoff-api-1" }), call("web_research", { query: "retry budgets" })],
    });
    assert.deepEqual(receipt.issues, []);
  });

  it("no report is blocking", () => {
    const receipt = child({ calls: [call("artifact_recall", { id: "handoff-api-1" })] });
    assert.ok(receipt.issues.some((i) => i.code === "report-missing" && i.blocking));
    assert.equal(unresolvedBlockers(receipt).length, 1);
    assert.equal(unresolvedBlockers(receipt, ["report-missing"]).length, 0);
  });

  it("a write outside the lane is blocking, absolute paths included", () => {
    const receipt = child({
      report: "retry budget configurable; errors logged",
      calls: [call("artifact_recall", { id: "handoff-api-1" }), call("write", { path: "/repo/src/billing.ts" }), call("edit", { path: "src/api/a.ts" })],
    });
    assert.deepEqual(receipt.outOfLane, ["src/billing.ts"]);
  });

  it("scratch and .pi writes are not lane violations", () => {
    const receipt = child({ report: "retry budget configurable; errors logged", calls: [call("write", { path: ".pi/x.md" }), call("write", { path: "/tmp/y" })] });
    assert.deepEqual(receipt.outOfLane, []);
  });

  it("a criterion the report never mentions is advisory, not blocking", () => {
    const receipt = child({ report: "Did some things.", calls: [call("artifact_recall", { id: "handoff-api-1" })] });
    const unreported = receipt.issues.filter((i) => i.code === "criterion-not-reported");
    assert.equal(unreported.length, 2);
    assert.ok(unreported.every((i) => !i.blocking));
  });

  it("exit without agent_done is blocking", () => {
    const receipt = child({ report: "retry budget configurable; errors logged", outcome: "completed-user-exit" });
    assert.ok(receipt.issues.some((i) => i.code === "no-clean-exit" && i.blocking));
  });

  it("helpers", () => {
    assert.equal(roundOfHandoff("handoff-api-3"), 3);
    assert.equal(roundOfHandoff(undefined), 1);
    assert.equal(criterionMentioned("retry budget is configurable", "the retry budget can be configured"), true);
  });
});

describe("agent_accept_result honours the receipt", () => {
  function accept() {
    const tools = new Map<string, any>();
    agentExtension(
      { registerTool: (t: any) => tools.set(t.name, t), registerCommand() {}, on() {}, getAllTools: () => [], events: undefined } as any,
      { client: {} as any, stream: { watch: () => () => {}, onReconcile: () => () => {} } },
    );
    const ctx: any = { cwd: tmpdir(), sessionManager: { getSessionId: () => "sess-owner" } };
    return (args: object) => tools.get("agent_accept_result").execute("t", args, undefined, undefined, ctx);
  }
  const row = (): ScopedChild => ({
    id: "rc-1", name: "W", scope: "api", sessionFile: "/tmp/receipt-gate/rc-1.jsonl", status: "running",
    laneFiles: ["src/api/"], lastMilestoneFiles: [], updatedAt: "2026-01-01",
    accountability: { ownerSessionId: "sess-owner", batchId: "b", workUnitKey: "u", delegationReason: "r", reviewPlan: "p", resultRevision: 0, disposition: "pending", reviews: [], attempts: [] },
  });
  const args = { childId: "rc-1", disposition: "accepted", resultRevision: 1, summary: "read it", evidence: ["ran tests"], integration: "merged" };

  it("refuses acceptance over a blocking issue, allows a named override", async () => {
    registry.resetForTests();
    const run = accept();
    registry.registerChild(row());
    registry.updateStatus("/tmp/receipt-gate/rc-1.jsonl", "completed");
    registry.updateRuntime("/tmp/receipt-gate/rc-1.jsonl", {
      receipt: { checkedAt: "x", reportId: "report-api-1", reportFound: false, outOfLane: [], issues: [{ code: "report-missing", blocking: true, detail: "none" }] },
    });
    const refused = await run(args);
    assert.equal(refused.details.error, "receipt-blocking");
    const ok = await run({ ...args, overrides: ["report-missing"], summary: "no report, but I verified the diff directly" });
    assert.match(String(ok.content[0].text), /dispositioned: accepted/);
  });
});

describe("agent_accept_result binds the verdict to frozen criteria", () => {
  it("requires a verdict per criterion and verifies the evidence", async () => {
    registry.resetForTests();
    const tools = new Map<string, any>();
    agentExtension(
      { registerTool: (t: any) => tools.set(t.name, t), registerCommand() {}, on() {}, getAllTools: () => [], events: undefined } as any,
      { client: {} as any, stream: { watch: () => () => {}, onReconcile: () => () => {} } },
    );
    const cwd = mkdtempSync(join(tmpdir(), "accept-cwd-"));
    writeFileSync(join(cwd, "out.md"), "findings");
    const ctx: any = { cwd, sessionManager: { getSessionId: () => "sess-owner", getBranch: () => [] } };
    const run = (args: object) => tools.get("agent_accept_result").execute("t", args, undefined, undefined, ctx);
    registry.registerChild({
      id: "bc-1", name: "R", scope: "topic", sessionFile: "/tmp/bind-criteria/bc-1.jsonl", status: "running",
      laneFiles: [], lastMilestoneFiles: [], updatedAt: "2026-01-01", frozenCriteria: ["names three sources", "states the limits"],
      accountability: { ownerSessionId: "sess-owner", batchId: "b", workUnitKey: "u", delegationReason: "r", reviewPlan: "p", resultRevision: 0, disposition: "pending", reviews: [], attempts: [] },
    } as ScopedChild);
    registry.updateStatus("/tmp/bind-criteria/bc-1.jsonl", "completed");
    const base = { childId: "bc-1", disposition: "accepted", resultRevision: 1, summary: "read it", integration: "used in the memo" };

    assert.equal((await run({ ...base, evidence: ["out.md"] })).details.error, "criteria-required");
    const bad = await run({ ...base, criteria: [{ criterion: "1", met: true, evidence: ["out.md"] }] });
    assert.equal(bad.details.error, "verdict-invalid");
    const good = await run({ ...base, criteria: [
      { criterion: "1", met: true, evidence: ["out.md"] },
      { criterion: "2", met: true, evidence: ["out.md:1"] },
    ] });
    assert.match(String(good.content[0].text), /dispositioned: accepted/, String(good.content[0].text));
    const review = registry.getChildById("bc-1")!.accountability!.reviews.at(-1)!;
    assert.equal(review.criteria?.length, 2);
  });
});

describe("auto-resume of transient failures", () => {
  it("backs off exponentially, honours the provider's wait, and is capped", () => {
    assert.equal(autoResumeDelayMs(0), 15_000);
    assert.equal(autoResumeDelayMs(1), 30_000);
    assert.equal(autoResumeDelayMs(0, 60_000), 65_000);
    assert.equal(autoResumeDelayMs(10), 600_000);
  });

  it("does not resume a row the parent already judged or that is no longer failed", async () => {
    registry.resetForTests();
    agentExtension(
      { registerTool() {}, registerCommand() {}, on() {}, getAllTools: () => [], events: undefined } as any,
      { client: {} as any, stream: { watch: () => () => {}, onReconcile: () => () => {} } },
    );
    // No row at all: the seam must be a harmless no-op, never a launch.
    await autoResumeSeams.run!("/tmp/none.jsonl");
  });
});
