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
});
