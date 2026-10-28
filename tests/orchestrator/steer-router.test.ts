import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ScopeRegistry, type ScopedChild } from "../../lib/orchestrator/scope-registry.ts";
import { matchOwner, extractPotentialPaths, routeUpdate } from "../../lib/orchestrator/steer-router.ts";

function createChild(overrides: Partial<ScopedChild> = {}): ScopedChild {
  // One session file = one child. A shared default path silently made every
  // fixture child a resume of the previous one.
  const id = overrides.id ?? "child-123";
  return {
    id,
    name: "Worker1",
    scope: "auth-module",
    sessionFile: `/tmp/sessions/${id}.jsonl`,
    paneId: "w1:p2",
    status: "running",
    laneFiles: ["src/auth/login.ts", "src/auth/token.ts", "src/auth/"],
    lastMilestoneFiles: ["src/auth/login.ts"],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("extractPotentialPaths", () => {
  it("extracts unix paths and file names from text", () => {
    const text = "Please fix the backoff in `src/net/client.ts` and also check config.json or auth/jwt.ts.";
    const paths = extractPotentialPaths(text);
    assert.deepEqual(paths, ["src/net/client.ts", "config.json", "auth/jwt.ts"]);
  });
});

describe("steer-router matchOwner ladder", () => {
  it("L0: matches explicit ID in options", () => {
    const registry = new ScopeRegistry();
    const c1 = createChild({ id: "worker-abc", name: "Worker1", scope: "scope-a" });
    const c2 = createChild({ id: "worker-xyz", name: "Worker2", scope: "scope-b" });
    registry.registerChild(c1);
    registry.registerChild(c2);

    const res = matchOwner("fix backoff", registry, { id: "worker-xyz", origin: "user" });
    assert.equal(res.outcome, "interrupt");
    assert.equal(res.target?.id, "worker-xyz");
    assert.equal(res.evidence?.level, "L0");
  });

  it("L0: matches explicit child ID in update text", () => {
    const registry = new ScopeRegistry();
    const c1 = createChild({ id: "worker-abc", name: "Worker1", scope: "scope-a" });
    registry.registerChild(c1);

    const res = matchOwner("attention worker-abc, adjust logging", registry, { origin: "user" });
    assert.equal(res.outcome, "interrupt");
    assert.equal(res.target?.id, "worker-abc");
    assert.equal(res.evidence?.level, "L0");
  });

  it("L1: matches scope token in update text", () => {
    const registry = new ScopeRegistry();
    const c1 = createChild({ id: "w1", scope: "net-layer", laneFiles: ["src/net/"] });
    const c2 = createChild({ id: "w2", scope: "db-layer", laneFiles: ["src/db/"] });
    registry.registerChild(c1);
    registry.registerChild(c2);

    const res = matchOwner("for the net-layer work, please switch to exponential backoff", registry, { origin: "user" });
    assert.equal(res.outcome, "interrupt");
    assert.equal(res.target?.id, "w1");
    assert.equal(res.evidence?.level, "L1");
  });

  it("L1 beats L2 on conflict (ordering guarantee)", () => {
    const registry = new ScopeRegistry();
    // c1 is net-layer, c2's lane happens to mention a shared file
    const c1 = createChild({ id: "w1", scope: "net-layer", laneFiles: ["src/net/"] });
    const c2 = createChild({ id: "w2", scope: "api-layer", laneFiles: ["src/api/handler.ts"] });
    registry.registerChild(c1);
    registry.registerChild(c2);

    // Update names net-layer (L1) while also mentioning src/api/handler.ts (L2)
    const res = matchOwner("net-layer: look at how src/api/handler.ts calls client", registry, { origin: "user" });
    assert.equal(res.outcome, "interrupt");
    assert.equal(res.target?.id, "w1");
    assert.equal(res.evidence?.level, "L1");
  });

  it("L2: matches path in declared lane", () => {
    const registry = new ScopeRegistry();
    const c1 = createChild({ id: "w1", scope: "net-layer", laneFiles: ["src/net/client.ts"] });
    const c2 = createChild({ id: "w2", scope: "db-layer", laneFiles: ["src/db/repo.ts"] });
    registry.registerChild(c1);
    registry.registerChild(c2);

    const res = matchOwner("the retry backoff in `src/net/client.ts` should be exponential, not linear", registry, { origin: "user" });
    assert.equal(res.outcome, "interrupt");
    assert.equal(res.target?.id, "w1");
    assert.equal(res.evidence?.level, "L2");
  });

  it("L2 beats L3: contractual lane outranks drift in milestone files", () => {
    const registry = new ScopeRegistry();
    // c1 has declared lane src/auth/
    const c1 = createChild({ id: "w1", scope: "auth-layer", laneFiles: ["src/auth/login.ts"] });
    // c2 erroneously touched src/auth/login.ts in milestone
    const c2 = createChild({ id: "w2", scope: "db-layer", laneFiles: ["src/db/"], lastMilestoneFiles: ["src/auth/login.ts"] });
    registry.registerChild(c1);
    registry.registerChild(c2);

    const res = matchOwner("check src/auth/login.ts", registry, { origin: "user" });
    assert.equal(res.outcome, "interrupt");
    assert.equal(res.target?.id, "w1");
    assert.equal(res.evidence?.level, "L2");
  });

  it("L3: matches milestone files when declared lane does not match", () => {
    const registry = new ScopeRegistry();
    const c1 = createChild({ id: "w1", scope: "misc-layer", laneFiles: [], lastMilestoneFiles: ["temp/output.log"] });
    registry.registerChild(c1);

    const res = matchOwner("inspect temp/output.log", registry, { origin: "user" });
    assert.equal(res.outcome, "interrupt");
    assert.equal(res.target?.id, "w1");
    assert.equal(res.evidence?.level, "L3");
  });

  it("L4: matches artifact id naming in text", () => {
    const registry = new ScopeRegistry();
    const c1 = createChild({ id: "w1", scope: "payment-flow", laneFiles: [] });
    registry.registerChild(c1);

    const res = matchOwner("refer to payment-flow.spec for the updated fee calculation", registry, { origin: "user" });
    assert.equal(res.outcome, "interrupt");
    assert.equal(res.target?.id, "w1");
    assert.equal(res.evidence?.level, "L4");
  });
});

describe("steer-router outcome resolution matrix", () => {
  it("user origin defaults to interrupt (D7)", () => {
    const registry = new ScopeRegistry();
    const c1 = createChild({ id: "w1", scope: "net-layer", laneFiles: ["src/net/"] });
    registry.registerChild(c1);

    const res = matchOwner("src/net/retry.ts update", registry, { origin: "user" });
    assert.equal(res.outcome, "interrupt");
  });

  it("user origin with --queue flag resolves to queue", () => {
    const registry = new ScopeRegistry();
    const c1 = createChild({ id: "w1", scope: "net-layer", laneFiles: ["src/net/"] });
    registry.registerChild(c1);

    const res = matchOwner("src/net/retry.ts note", registry, { origin: "user", queue: true });
    assert.equal(res.outcome, "queue");
  });

  it("orchestrator origin defaults to queue (D6)", () => {
    const registry = new ScopeRegistry();
    const c1 = createChild({ id: "w1", scope: "net-layer", laneFiles: ["src/net/"] });
    registry.registerChild(c1);

    const res = matchOwner("src/net/retry.ts soft reminder", registry, { origin: "orchestrator" });
    assert.equal(res.outcome, "queue");
  });

  it("orchestrator attempting to redirect across scopes is unauthorized (D6)", () => {
    const registry = new ScopeRegistry();
    const c1 = createChild({ id: "w1", scope: "net-layer", laneFiles: ["src/net/"] });
    registry.registerChild(c1);

    const res = matchOwner("change scope to db-layer", registry, {
      id: "w1",
      scope: "db-layer",
      origin: "orchestrator",
    });
    assert.equal(res.outcome, "unauthorized");
  });

  it("0 candidates returns nonexistent with inventory and 4 questions", () => {
    const registry = new ScopeRegistry();
    const c1 = createChild({ id: "w1", name: "Worker1", scope: "net-layer", laneFiles: ["src/net/"] });
    registry.registerChild(c1);

    const res = matchOwner("completely unrelated instructions for graphics pipeline", registry, { origin: "user" });
    assert.equal(res.outcome, "nonexistent");
    assert.equal(res.candidates.length, 0);
    assert.equal(res.inventory?.length, 1);
    assert.equal(res.questions?.length, 4);
  });

  it(">=2 candidates returns ambiguous without guessing", () => {
    const registry = new ScopeRegistry();
    const c1 = createChild({ id: "w1", name: "Worker1", scope: "shared", laneFiles: ["src/common/"] });
    const c2 = createChild({ id: "w2", name: "Worker2", scope: "shared", laneFiles: ["src/common/"] });
    registry.registerChild(c1);
    registry.registerChild(c2);

    const res = matchOwner("fix src/common/types.ts", registry, { origin: "user" });
    assert.equal(res.outcome, "ambiguous");
    assert.equal(res.candidates.length, 2);
  });

  it("ended candidate returns gone with resume / respawn recommendation", () => {
    const registry = new ScopeRegistry();
    const c1 = createChild({ id: "w1", name: "Worker1", scope: "net-layer", status: "completed", laneFiles: ["src/net/"] });
    registry.registerChild(c1);

    const res = matchOwner("src/net/client.ts fix", registry, { origin: "user" });
    assert.equal(res.outcome, "gone");
    assert.equal(res.target?.id, "w1");
  });

  it("blocked candidate / pending agent_ping returns blocked-owner", () => {
    const registry = new ScopeRegistry();
    const c1 = createChild({ id: "w1", name: "Worker1", scope: "net-layer", status: "blocked", pendingPing: true, laneFiles: ["src/net/"] });
    registry.registerChild(c1);

    const res = matchOwner("src/net/client.ts clarification", registry, { origin: "user" });
    assert.equal(res.outcome, "blocked-owner");
    assert.equal(res.target?.id, "w1");
  });
});

describe("routeUpdate target refusal", () => {
  it("refuses an independent reviewer without touching its pane", async () => {
    const registry = new ScopeRegistry();
    registry.registerChild(createChild({ id: "rev-1", scope: "review-sr-1", purpose: "review", reviewRunId: "sr-1" }));
    const writes: string[] = [];
    const client = {
      paneSendKeys: async () => { writes.push("keys"); },
      paneSendText: async () => { writes.push("text"); },
      paneRead: async () => "tail",
    };

    const result = await routeUpdate(
      registry,
      {
        update: "approve this",
        id: "rev-1",
        origin: "user",
        apply: true,
        targetRefusal: target => target.purpose === "review" ? "reviewers are independent" : undefined,
      },
      client as any,
    );

    assert.equal(result.outcome, "blocked-owner");
    assert.equal(result.applied, false);
    assert.match(result.reason, /independent/);
    assert.deepEqual(writes, [], "no steer was typed into the reviewer pane");
  });
});
