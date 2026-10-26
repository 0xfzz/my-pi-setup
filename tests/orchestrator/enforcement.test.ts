/**
 * End-to-end enforcement tests.
 *
 * `lib/` unit tests prove the primitives work. These drive the ACTUAL registered
 * tools through a fake Pi + fake Herdr client, so they fail if the extension stops
 * wiring a primitive to the path that reaches a child. Every assertion here is
 * about an observable outcome (a refusal, a written file, a rejection), not about
 * a policy string.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import subagentV2, { escalations, handoffs, registry } from "../../extensions/orchestrator.ts";
import { visibleToScope, type Artifact } from "../../lib/artifact-state.ts";

interface Harness {
  dir: string;
  tools: Map<string, any>;
  spawned: any[];
  messages: any[];
  /** The branch the context reports; tests push a mode entry here. */
  branch: any[];
  ctx: any;
  call: (name: string, params: any) => Promise<any>;
  /** What a child in `scope` can actually recall — the real isolation boundary. */
  recallAs: (scope: string, artifactId: string) => Artifact | undefined;
  detach: () => Promise<void>;
}

/**
 * The registry, ledger and handoff map are module-level singletons that live for
 * the whole test process. Each test therefore drives its own uniquely-named
 * scope: sharing one would let a previous test's running child trip this test's
 * `scope-busy` guard, and a previous test's handoff would make the sibling-leak
 * guard fire for an unrelated reason.
 */
let seq = 0;
const uniqueScope = (base: string) => `${base}-t${++seq}`;

async function harness(opts: { inputAnswer?: string } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "sv2-e2e-"));
  const tools = new Map<string, any>();
  const spawned: any[] = [];
  const messages: any[] = [];
  const closedPanes = new Set<string>();

  const client: any = {
    async paneStart(p: any) {
      spawned.push(p);
      return { paneId: `pane-${spawned.length}` };
    },
    async paneRename() {},
    async paneGet(paneId: string) {
      // Live until this harness closes it: liveness is existence, not a guess.
      return closedPanes.has(paneId) ? null : { pane_id: paneId };
    },
    async paneRead() {
      return null;
    },
    async paneList() {
      return [];
    },
    async paneClose(paneId: string) {
      closedPanes.add(paneId);
    },
    async paneSendText() {},
  };

  const hooks = new Map<string, Function[]>();
  const branch: any[] = [];
  const pi: any = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on(name: string, fn: Function) {
      hooks.set(name, [...(hooks.get(name) ?? []), fn]);
    },
    getAllTools() {
      return [...tools.values()];
    },
    appendEntry() {},
    sendMessage(message: any) {
      messages.push(message);
    },
  };

  /**
   * The workspace artifact catalog, as `orch_handoff` publishes into it.
   *
   * `visibleToScope` is imported from the real package rather than reimplemented,
   * so these assertions cannot drift away from the isolation rule production uses.
   */
  const catalog = new Map<string, Artifact>();

  const ctx: any = {
    cwd: dir,
    mode: "tui",
    sessionManager: {
      getSessionId: () => "parent-session",
      getSessionFile: () => join(dir, "parent-session.jsonl"),
      getSessionDir: () => dir,
      getBranch: () => branch,
    },
    ui: {
      notify() {},
      async input() {
        return opts.inputAnswer ?? "";
      },
      async select() {
        return "";
      },
      async confirm() {
        return false;
      },
    },
    async executeTool(name: string, args: any) {
      if (name === "artifact_save") {
        const art: Artifact = {
          id: args.id,
          title: args.title,
          type: args.type,
          content: args.content,
          createdBy: "main",
          tags: [],
          version: (catalog.get(args.id)?.version ?? 0) + 1,
          createdAt: catalog.get(args.id)?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...(args.scope ? { scope: args.scope } : {}),
        };
        catalog.set(art.id, art);
        return { isError: false, result: { content: [{ type: "text", text: `saved ${art.id}` }] } };
      }
      if (name === "artifact_recall") {
        const art = catalog.get(args.id);
        return {
          isError: false,
          result: { content: [{ type: "text", text: art ? art.content : `No artifact ${args.id}` }] },
        };
      }
      return { isError: true, result: { content: [{ type: "text", text: `unknown tool ${name}` }] } };
    },
  };

  subagentV2(pi, { client, stream: { watch: () => () => {}, onReconcile: () => () => {} } });

  return {
    dir,
    tools,
    spawned,
    messages,
    branch,
    ctx,
    async call(name: string, params: any) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} is registered`);
      return tool.execute("call-id", params, undefined, undefined, ctx);
    },
    recallAs(scope: string, artifactId: string) {
      const art = catalog.get(artifactId);
      if (!art) return undefined;
      return visibleToScope(art, scope) ? art : undefined;
    },
    async detach() {
      // Behave like a real shutdown: abort the watchers first. A live watcher
      // holds an fs.watch handle and a poll timer, which would keep the test
      // process alive after the assertions are done.
      for (const stop of hooks.get("session_shutdown") ?? []) await stop({}, ctx);
      // The registry is a module-level singleton shared across tests. Children
      // left "running" here would trip the lane-conflict gate in later tests,
      // so every test ends its children explicitly.
      for (const child of registry.getAllChildren()) {
        if (child.paneId) closedPanes.add(child.paneId);
        registry.updateStatus(child.sessionFile, "closed");
      }
      handoffs.clear();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Collect every file a child's launch plan materialized, concatenated. */
async function deliveredTicket(dir: string, handoffId: string): Promise<string> {
  const root = join(dir, "artifacts", `parent-session-${handoffId}`);
  const entries = (await readdir(root, { recursive: true, withFileTypes: true } as any)) as any[];
  const parts: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    parts.push(await readFile(join(entry.parentPath ?? entry.path, entry.name), "utf8"));
  }
  return parts.join("\n");
}

const handoffParams = (over: Record<string, unknown> = {}) => ({
  scope: "net-retry",
  goal: "Make retry backoff exponential with jitter.",
  acceptanceCriteria: ["Backoff is exponential", "Jitter is applied"],
  laneFiles: ["src/net/client.ts"],
  outOfLaneFiles: ["src/auth/jwt.ts"],
  ...over,
});

test("concept 1: the orchestrator authors a handoff then delegates; a spec-less spawn is refused", async () => {
  const h = await harness();
  const scope = uniqueScope("net-retry");
  try {
    // Without a handoff there is no spec, no lane, and nothing to review.
    const noSpec = await h.call("orch_spawn", { name: "W", task: "do it", handoffId: "nope" });
    assert.equal(noSpec.details.error, "handoff-required");
    assert.match(noSpec.content[0].text, /Author one first with orch_handoff/);
    assert.equal(h.spawned.length, 0, "no pane started without a spec");

    const authored = await h.call("orch_handoff", handoffParams({ scope }));
    assert.equal(authored.details.scope, scope);
    assert.equal(authored.details.revision, 1);
    // The spec is published as a scoped artifact, and the child is pointed at it
    // rather than handed the body inline.
    assert.match(authored.content[0].text, /visible only to scope/);
    assert.match(authored.content[0].text, /recall/);
    assert.equal(typeof authored.details.artifactId, "string");
    assert.ok(h.recallAs(scope, authored.details.artifactId), "the child's own scope can recall its spec");

    // The audit copy is written, and it is private.
    assert.equal((await stat(authored.details.path)).mode & 0o777, 0o600);

    const spawned = await h.call("orch_spawn", {
      name: "NetWorker",
      task: "Implement it in src/net/client.ts.",
      handoffId: authored.details.id,
    });
    assert.equal(spawned.details.status, "started");
    assert.equal(spawned.details.scope, scope);
    assert.equal(spawned.details.handoffId, authored.details.id);
    assert.equal(h.spawned.length, 1);
  } finally {
    handoffs.clear();
    await h.detach();
  }
});

test("concept 1: a handoff with no lane, no goal, or no criteria is rejected before any child exists", async () => {
  const h = await harness();
  const scope = uniqueScope("bad");
  try {
    const noLane = await h.call("orch_handoff", handoffParams({ scope, laneFiles: [] }));
    assert.match(noLane.content[0].text, /Handoff rejected: .*lane/);

    const noGoal = await h.call("orch_handoff", handoffParams({ scope, goal: "  " }));
    assert.match(noGoal.content[0].text, /Handoff rejected: .*goal/);

    const noCriteria = await h.call("orch_handoff", handoffParams({ scope, acceptanceCriteria: ["  "] }));
    assert.match(noCriteria.content[0].text, /Handoff rejected: .*criterion/);

    assert.equal(
      [...handoffs.values()].some((entry) => entry.record.scope === scope),
      false,
      "no spec was recorded",
    );
    assert.equal(h.spawned.length, 0);
  } finally {
    handoffs.clear();
    await h.detach();
  }
});

test("concept 1: Normal spawns an ad-hoc unit without a handoff and orch_check says not-declared", async () => {
  const h = await harness();
  const name = uniqueScope("spike");
  try {
    const spawned = await h.call("orch_spawn", {
      name,
      task: "Inspect the retry path and report what would change.",
      purpose: "adhoc",
    });
    assert.equal(spawned.details.status, "started");
    assert.equal(spawned.details.handoffId, undefined, "an ad-hoc unit has no handoff id");
    assert.equal(spawned.details.purpose, "adhoc");
    assert.match(spawned.content[0].text, /ad-hoc, no handoff spec/);
    assert.equal(h.spawned.length, 1, "exactly one pane, and it exists");

    const checked = await h.call("orch_check", { scope: spawned.details.scope });
    assert.equal(checked.details.lane.state, "not-declared");
  } finally {
    handoffs.clear();
    await h.detach();
  }
});

test("concept 1: Plan admits research but refuses ad-hoc and implementation before a pane exists", async () => {
  const h = await harness();
  h.branch.push({ type: "custom", customType: "input-plan-mode:v1", data: { enabled: true } });
  try {
    for (const purpose of ["adhoc", "implementation"] as const) {
      const refused = await h.call("orch_spawn", { name: uniqueScope(`x-${purpose}`), task: "t", purpose });
      assert.equal(refused.details.error, "purpose-refused", purpose);
      assert.equal(refused.details.mode, "plan");
    }
    assert.equal(h.spawned.length, 0, "a refused spawn starts nothing");

    const research = await h.call("orch_spawn", { name: uniqueScope("reader"), task: "Inspect the retry path." });
    assert.equal(research.details.status, "started", "Plan defaults to a research child");
    assert.equal(research.details.purpose, "research");
    assert.equal(h.spawned.length, 1);
  } finally {
    handoffs.clear();
    await h.detach();
  }
});

test("concept 4: a delegated child may not spawn again, and the refusal writes nothing", async () => {
  const h = await harness();
  const previous = process.env.PI_SUBAGENT_DEPTH;
  process.env.PI_SUBAGENT_DEPTH = "1";
  try {
    const refused = await h.call("orch_spawn", { name: uniqueScope("nested"), task: "nest", purpose: "adhoc" });
    assert.equal(refused.details.error, "depth-limit");
    assert.match(refused.content[0].text, /Delegation depth limit reached/);
    assert.equal(h.spawned.length, 0, "no pane below the depth limit");
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = previous;
    handoffs.clear();
    await h.detach();
  }
});

test("concept 4: the child cap refuses the next spawn before a pane exists", async () => {
  const h = await harness();
  const previous = process.env.PI_SUBAGENT_MAX_CHILDREN;
  process.env.PI_SUBAGENT_MAX_CHILDREN = "1";
  try {
    const first = await h.call("orch_spawn", { name: uniqueScope("cap-a"), task: "a", purpose: "adhoc" });
    assert.equal(first.details.status, "started");

    const second = await h.call("orch_spawn", { name: uniqueScope("cap-b"), task: "b", purpose: "adhoc" });
    assert.equal(second.details.error, "child-limit");
    assert.match(second.content[0].text, /Child limit reached \(1\/1\)/);
    assert.equal(h.spawned.length, 1, "the refused spawn did not start a pane");
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_MAX_CHILDREN;
    else process.env.PI_SUBAGENT_MAX_CHILDREN = previous;
    handoffs.clear();
    await h.detach();
  }
});

test("concept 2: a child's delivered ticket carries its own handoff and no sibling identity", async () => {
  const h = await harness();
  const netScope = uniqueScope("net-retry");
  const dbScope = uniqueScope("db-pool");
  try {
    const net = await h.call("orch_handoff", handoffParams({ scope: netScope }));
    const db = await h.call(
      "orch_handoff",
      handoffParams({
        scope: dbScope,
        goal: "Pool database connections.",
        laneFiles: ["src/db/pool.ts"],
        outOfLaneFiles: [],
      }),
    );
    assert.notEqual(net.details.id, db.details.id);

    await h.call("orch_spawn", { name: "NetWorker", task: "Implement exponential backoff.", handoffId: net.details.id });
    await h.call("orch_spawn", { name: "DbWorker", task: "Implement the pool.", handoffId: db.details.id });
    assert.equal(h.spawned.length, 2, "both children launched");

    const netTicket = await deliveredTicket(h.dir, net.details.id);
    const dbTicket = await deliveredTicket(h.dir, db.details.id);

    // The ticket carries a POINTER, not the document. This is the whole point of
    // the artifact form: the child recalls its spec instead of being handed
    // thousands of tokens of prose before it reads a line of code.
    assert.match(netTicket, new RegExp(`artifact_recall.*${net.details.artifactId}`));
    assert.match(dbTicket, new RegExp(`artifact_recall.*${db.details.artifactId}`));
    assert.equal(netTicket.includes("## Acceptance criteria"), false, "spec body must not be inlined");
    assert.equal(dbTicket.includes("## Acceptance criteria"), false, "spec body must not be inlined");
    // The ticket says an unavailable spec is a blocker, never something to infer.
    assert.match(netTicket, /do NOT guess your lane/);

    // Sibling identity absent — the isolation invariant, checked against the bytes
    // actually handed to each child.
    assert.equal(netTicket.includes(dbScope), false, "net child must not learn db-pool");
    assert.equal(netTicket.includes("src/db/pool.ts"), false, "net child must not learn db-pool's lane");
    assert.equal(dbTicket.includes(netScope), false, "db child must not learn net-retry");
    assert.equal(dbTicket.includes("src/net/client.ts"), false, "db child must not learn net-retry's lane");

    // The real boundary is the catalog, not prompt distance: each child can recall
    // its own spec and is refused the sibling's.
    assert.ok(h.recallAs(netScope, net.details.artifactId), "net child recalls its own spec");
    assert.ok(h.recallAs(dbScope, db.details.artifactId), "db child recalls its own spec");
    assert.equal(h.recallAs(netScope, db.details.artifactId), undefined, "net child cannot recall the db spec");
    assert.equal(h.recallAs(dbScope, net.details.artifactId), undefined, "db child cannot recall the net spec");

    // And the spec body really does hold the lane, so recall is worth doing.
    assert.match(h.recallAs(netScope, net.details.artifactId)!.content, /src\/net\/client\.ts/);
  } finally {
    handoffs.clear();
    await h.detach();
  }
});

test("concept 2: a task naming a sibling scope is refused at spawn, not sanitized afterwards", async () => {
  const h = await harness();
  const netScope = uniqueScope("net-retry");
  const dbScope = uniqueScope("db-pool");
  try {
    const net = await h.call("orch_handoff", handoffParams({ scope: netScope }));
    await h.call("orch_handoff", handoffParams({ scope: dbScope, goal: "Pool connections.", laneFiles: ["src/db/pool.ts"] }));

    const leaked = await h.call("orch_spawn", {
      name: "NetWorker",
      task: `Implement backoff. Note that ${dbScope} is doing the connection work.`,
      handoffId: net.details.id,
    });

    assert.equal(leaked.details.error, "sibling-leak");
    assert.deepEqual(leaked.details.leaked, [dbScope]);
    assert.match(leaked.content[0].text, /Refused to spawn/);
    assert.equal(h.spawned.length, 0, "no child was launched with a leaky ticket");
  } finally {
    handoffs.clear();
    await h.detach();
  }
});

test("concept 1: the review gate refuses a failing criterion or an out-of-lane diff", async () => {
  const h = await harness();
  const scope = uniqueScope("net-retry");
  try {
    await h.call("orch_handoff", handoffParams({ scope }));

    const failed = await h.call("orch_review", {
      scope,
      verdict: "approved",
      criteriaNotes: [{ criterion: "Backoff is exponential", evidence: "read src/net/client.ts:40", passed: false }],
      laneCompliance: { inLane: true },
      summary: "Looks fine.",
    });
    assert.equal(failed.details.error, "contradictory-verdict");
    assert.match(failed.content[0].text, /Refusing to approve/);

    const outsideLane = await h.call("orch_review", {
      scope,
      verdict: "approved",
      criteriaNotes: [{ criterion: "Backoff is exponential", evidence: "read src/net/client.ts:40", passed: true }],
      laneCompliance: { inLane: false, violations: ["src/auth/jwt.ts"] },
      summary: "Touched auth but tests pass.",
    });
    assert.equal(outsideLane.details.error, "out-of-lane");
    assert.match(outsideLane.content[0].text, /regardless of quality/);

    // A legitimate approval still works, so the gate is not simply always-closed.
    const approved = await h.call("orch_review", {
      scope,
      verdict: "approved",
      criteriaNotes: [
        {
          criterion: "Backoff is exponential",
          evidence: "read the diff",
          evidenceRefs: [{ kind: "cmd", cmd: "git diff --stat", exit: 0 }],
          passed: true,
        },
        {
          criterion: "Jitter is applied",
          evidence: "read the diff",
          evidenceRefs: [{ kind: "test", name: "backoff.test.ts::jitter is applied", pass: true }],
          passed: true,
        },
      ],
      laneCompliance: { inLane: true },
      summary: "Both criteria verified in the diff.",
    });
    assert.equal(approved.details.verdict, "approved");
    assert.equal(approved.details.inLane, true);
  } finally {
    handoffs.clear();
    await h.detach();
  }
});

test("concept 3: the ladder answers from orchestrator context, then refuses renegotiation", async () => {
  const h = await harness();
  try {
    const esc = escalations.open({
      id: `esc-orch-${++seq}`,
      childId: "child-1",
      childName: "NetWorker",
      scope: "net-retry",
      sessionFile: join(h.dir, "child.jsonl"),
      question: "Should the backoff cap be 30s or 60s?",
    });
    assert.equal(esc.stage, "orchestrator", "a child's question starts with the orchestrator");

    // The orchestrator knows, so it answers from its own context.
    const answered = await h.call("orch_escalate", { id: esc.id, action: "answer", answer: "Cap at 60s." });
    assert.equal(answered.details.status, "answered");
    assert.match(answered.details.resumeMessage, /decided by the orchestrator/);

    // A settled decision is not renegotiated.
    const again = await h.call("orch_escalate", { id: esc.id, action: "answer", answer: "Actually 30s." });
    assert.match(again.content[0].text, /already answered/);
    assert.equal(escalations.get(esc.id)!.answer, "Cap at 60s.");
  } finally {
    await h.detach();
  }
});

test("concept 3: an unanswered user dialog is CANCELLED, never treated as consent", async () => {
  // The user closes the dialog without typing anything.
  const h = await harness({ inputAnswer: "" });
  try {
    const esc = escalations.open({
      id: `esc-user-${++seq}`,
      childId: "child-2",
      childName: "DbWorker",
      scope: "db-pool",
      sessionFile: join(h.dir, "child2.jsonl"),
      question: "Should the pool be 10 or 20 connections?",
    });

    // The orchestrator does not know — this is a product decision — so it asks the user.
    const handed = await h.call("orch_escalate", { id: esc.id, action: "to-user", reason: "Capacity is a product call." });
    assert.equal(handed.details.status, "cancelled");
    assert.match(handed.content[0].text, /CANCELLED/);

    // Authority rule: having escalated it, the orchestrator may not answer it.
    const overreach = await h.call("orch_escalate", { id: esc.id, action: "answer", answer: "20." });
    assert.match(overreach.content[0].text, /cannot answer a question it already escalated/);

    assert.equal(escalations.get(esc.id)!.stage, "cancelled");
    assert.equal(escalations.get(esc.id)!.answer, undefined, "a cancelled dialog produced no decision");
  } finally {
    await h.detach();
  }
});

test("concept 3: two writers in one scope are refused, because nobody owns the diff", async () => {
  const h = await harness();
  const scope = uniqueScope("net-retry");
  try {
    const net = await h.call("orch_handoff", handoffParams({ scope }));
    await h.call("orch_spawn", { name: "A", task: "Implement backoff.", handoffId: net.details.id });

    const second = await h.call("orch_spawn", { name: "B", task: "Also implement backoff.", handoffId: net.details.id });
    assert.equal(second.details.error, "scope-busy");
    assert.match(second.content[0].text, /Two writers in one lane/);
  } finally {
    handoffs.clear();
    await h.detach();
  }
});
