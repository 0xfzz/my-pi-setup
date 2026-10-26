import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ScopeRegistry, type ScopedChild, type SteerRecord } from "../../lib/orchestrator/scope-registry.ts";

describe("ScopeRegistry", () => {
  it("registers and queries child by id, session, and scope", () => {
    const registry = new ScopeRegistry();
    const child: ScopedChild = {
      id: "run-101",
      name: "AuthWorker",
      scope: "auth-module",
      sessionFile: "/tmp/sessions/run-101.jsonl",
      laneFiles: ["src/auth/"],
      lastMilestoneFiles: [],
      status: "running",
      updatedAt: new Date().toISOString(),
    };

    registry.registerChild(child);

    assert.equal(registry.getChildById("run-101")?.name, "AuthWorker");
    assert.equal(registry.getChildBySession("/tmp/sessions/run-101.jsonl")?.id, "run-101");
    assert.equal(registry.getScopeForSession("/tmp/sessions/run-101.jsonl"), "auth-module");
    assert.equal(registry.getChildrenInScope("auth-module").length, 1);
  });

  it("updates child status and liveness indicators", () => {
    const registry = new ScopeRegistry();
    const child: ScopedChild = {
      id: "run-102",
      name: "DbWorker",
      scope: "db-layer",
      sessionFile: "/tmp/sessions/run-102.jsonl",
      laneFiles: ["src/db/"],
      lastMilestoneFiles: [],
      status: "running",
      updatedAt: new Date().toISOString(),
    };
    registry.registerChild(child);

    registry.updateStatus(child.sessionFile, "blocked", { pendingPing: true, paneId: "w1:p3" });
    const updated = registry.getChildById("run-102");
    assert.equal(updated?.status, "blocked");
    assert.equal(updated?.pendingPing, true);
    assert.equal(updated?.paneId, "w1:p3");
  });

  it("updates milestone files and records steer audits", () => {
    const registry = new ScopeRegistry();
    const child: ScopedChild = {
      id: "run-103",
      name: "ApiWorker",
      scope: "api-layer",
      sessionFile: "/tmp/sessions/run-103.jsonl",
      laneFiles: ["src/api/"],
      lastMilestoneFiles: [],
      status: "running",
      updatedAt: new Date().toISOString(),
    };
    registry.registerChild(child);

    registry.updateMilestone(child.sessionFile, ["src/api/router.ts", "src/api/schema.ts"]);
    assert.deepEqual(registry.getChildById("run-103")?.lastMilestoneFiles, ["src/api/router.ts", "src/api/schema.ts"]);

    const steer: SteerRecord = {
      id: "steer-1",
      childId: "run-103",
      scope: "api-layer",
      origin: "user",
      mode: "interrupt",
      message: "adjust route prefix",
      timestamp: new Date().toISOString(),
      status: "delivered",
    };
    registry.recordSteer(steer);

    const steers = registry.getSteers("run-103");
    assert.equal(steers.length, 1);
    assert.equal(steers[0].message, "adjust route prefix");
  });

  it("resolveLaneForPath matches exact path and directory prefixes", () => {
    const registry = new ScopeRegistry();
    registry.registerChild({
      id: "w1",
      name: "AuthWorker",
      scope: "auth-module",
      sessionFile: "/tmp/sessions/w1.jsonl",
      laneFiles: ["src/auth/login.ts", "src/auth/jwt/"],
      lastMilestoneFiles: [],
      status: "running",
      updatedAt: new Date().toISOString(),
    });

    const exactMatch = registry.resolveLaneForPath("src/auth/login.ts");
    assert.equal(exactMatch.length, 1);
    assert.equal(exactMatch[0].id, "w1");

    const prefixMatch = registry.resolveLaneForPath("src/auth/jwt/signer.ts");
    assert.equal(prefixMatch.length, 1);
    assert.equal(prefixMatch[0].id, "w1");

    const noMatch = registry.resolveLaneForPath("src/net/client.ts");
    assert.equal(noMatch.length, 0);
  });

  it("resuming a session file supersedes its previous row instead of forking a ghost", () => {
    // One session file = one live row. The old registry inserted by id and left
    // the previous row "running" forever, so one child produced budget notices
    // under three ids and two different budgets.
    const registry = new ScopeRegistry();
    const sessionFile = "/tmp/sessions/resume-once.jsonl";
    const base = {
      name: "Resumed worker",
      scope: "resume-scope",
      sessionFile,
      laneFiles: ["src/resume/"],
      lastMilestoneFiles: [],
      updatedAt: new Date().toISOString(),
    };

    registry.registerChild({ ...base, id: "run-first", status: "running" });
    const superseded = registry.registerChild({ ...base, id: "run-second", status: "running" });

    assert.equal(superseded.length, 1);
    assert.equal(superseded[0].id, "run-first");
    assert.equal(superseded[0].status, "closed");
    assert.equal(superseded[0].closeReason, "resume-superseded");
    assert.equal(superseded[0].watchdog?.trip, null);

    assert.equal(registry.getAllChildren().length, 1);
    assert.equal(registry.getChildById("run-second")?.supersededIds?.includes("run-first"), true);
    assert.equal(registry.getChildById("run-first"), undefined);
  });

  it("getWatchdogChildren excludes blocked and ping-paused children", () => {
    const registry = new ScopeRegistry();
    const base = (id: string, sessionFile: string) => ({
      id,
      name: id,
      scope: `scope-${id}`,
      sessionFile,
      laneFiles: ["src/x/"],
      lastMilestoneFiles: [],
      updatedAt: new Date().toISOString(),
    });

    registry.registerChild({ ...base("wd-running", "/tmp/sessions/wd-a.jsonl"), status: "running" });
    registry.registerChild({ ...base("wd-blocked", "/tmp/sessions/wd-b.jsonl"), status: "running" });
    registry.updateStatus("/tmp/sessions/wd-b.jsonl", "blocked");
    registry.registerChild({ ...base("wd-ping", "/tmp/sessions/wd-c.jsonl"), status: "running" });
    registry.updateStatus("/tmp/sessions/wd-c.jsonl", "blocked", { pendingPing: true });

    const ids = registry.getWatchdogChildren().map((c) => c.id);
    assert.deepEqual(ids, ["wd-running"]);
    // Routing still sees the paused child: a blocked child is waiting, not gone.
    assert.equal(registry.getActiveChildren().length, 3);
  });

  it("loadSnapshot keeps only the newest row per session file", () => {
    const registry = new ScopeRegistry();
    const sessionFile = "/tmp/sessions/snapshot-dup.jsonl";
    const row = (id: string, updatedAt: string, status: ScopedChild["status"]) => ({
      id,
      name: id,
      scope: "snapshot-scope",
      sessionFile,
      laneFiles: ["src/x/"],
      lastMilestoneFiles: [],
      status,
      updatedAt,
    });

    registry.loadSnapshot({
      version: 1,
      savedAt: new Date().toISOString(),
      children: [
        row("old-1", "2026-01-01T00:00:00.000Z", "running"),
        row("new-2", "2026-01-03T00:00:00.000Z", "running"),
        row("old-3", "2026-01-02T00:00:00.000Z", "running"),
      ],
      steers: [],
      reviews: [],
    });

    assert.equal(registry.getAllChildren().length, 1);
    const kept = registry.getChildBySession(sessionFile)!;
    assert.equal(kept.id, "new-2");
    assert.deepEqual([...(kept.supersededIds ?? [])].sort(), ["old-1", "old-3"]);
  });

  it("closeChild is terminal and idempotent; resetWatchdog re-arms the clock", () => {
    const registry = new ScopeRegistry();
    const sessionFile = "/tmp/sessions/close-reset.jsonl";
    registry.registerChild({
      id: "run-close",
      name: "CloseWorker",
      scope: "close-scope",
      sessionFile,
      laneFiles: ["src/close/"],
      lastMilestoneFiles: [],
      status: "running",
      updatedAt: new Date().toISOString(),
      startedAt: 1,
      budgetMs: 1_000,
      watchdog: { trip: "budget-exceeded", interrupts: 2 },
    });

    const closed = registry.closeChild(sessionFile, "review-approved");
    assert.equal(closed?.status, "closed");
    assert.equal(closed?.closeReason, "review-approved");
    assert.equal(closed?.watchdog?.trip, null);
    assert.ok(closed?.closedAt);

    // A later close must not rewrite the first, truthful reason.
    registry.closeChild(sessionFile, "pane-gone");
    assert.equal(registry.getChildBySession(sessionFile)?.closeReason, "review-approved");

    const rearmed = registry.resetWatchdog(sessionFile, { budgetMs: 5_000, startedAt: 42 });
    assert.equal(rearmed?.status, "running");
    assert.equal(rearmed?.closedAt, undefined);
    assert.equal(rearmed?.closeReason, undefined);
    assert.equal(rearmed?.watchdog?.trip, null);
    assert.equal(rearmed?.watchdog?.interrupts, 0);
    assert.equal(rearmed?.budgetMs, 5_000);
    assert.equal(rearmed?.startedAt, 42);
  });
});
