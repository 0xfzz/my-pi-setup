import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DashboardBridge,
  DASHBOARD_SYNC_EVENT,
  publishDashboardMode,
  type DashboardProducerFactory,
  type DashboardProducerOptions,
} from "../lib/dashboard/integration.ts";
import {
  projectArtifacts,
  projectChild,
  projectOrchestrator,
  projectSession,
  projectSnapshot,
  toArtifactRecord,
} from "../lib/dashboard/projection.ts";
import {
  DASHBOARD_ARTIFACTS_EVENT,
  DASHBOARD_REQUEST_EVENT,
  DASHBOARD_STATE_EVENT,
  emptyOrchestrator,
  type DashboardSnapshot,
} from "../lib/dashboard/protocol.ts";
import { ARTIFACT_TYPE, artifactSidecarPath, type Artifact } from "../lib/artifact-state.ts";
import { SUPERVISOR_MODE_TYPE } from "../lib/supervise-mode.ts";
import { SUBAGENT_CONTEXT_TYPE } from "../lib/subagent-context.ts";
import dashboardExtension from "../extensions/dashboard.ts";
import modesExtension from "../extensions/modes.ts";
import artifactsExtension from "../extensions/artifacts.ts";

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 400): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(`timed out waiting for ${label}`);
}

function createBus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(channel: string, handler: (data: unknown) => void) {
      const set = handlers.get(channel) ?? new Set();
      set.add(handler);
      handlers.set(channel, set);
      return () => set.delete(handler);
    },
    emit(channel: string, data: unknown) {
      for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
    },
  };
}

type Bus = ReturnType<typeof createBus>;

function createPi(bus: Bus, entries: any[] = []) {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  let seq = 0;
  const pi: any = {
    events: bus,
    on(name: string, fn: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, definition: any) {
      commands.set(name, definition);
    },
    registerShortcut() {},
    appendEntry(customType: string, data: any) {
      const entry = { id: `entry-${++seq}`, type: "custom", customType, data, timestamp: new Date().toISOString() };
      entries.push(entry);
      return entry.id;
    },
    sendMessage() {},
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools() {},
  };
  async function emit(name: string, event: any, context: any) {
    let result: any;
    for (const handler of handlers.get(name) ?? []) {
      const next = await handler(event, context);
      if (next !== undefined) result = next;
    }
    return result;
  }
  return { pi, handlers, tools, commands, entries, emit };
}

function createContext(entries: any[], opts: {
  idle?: boolean;
  sessionFile?: string;
  sessionDir?: string;
  header?: any;
  sessionId?: string;
  notices?: string[];
} = {}) {
  const notices = opts.notices ?? [];
  return {
    mode: "tui",
    hasUI: true,
    isIdle: () => opts.idle !== false,
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => opts.sessionId ?? "session-parent",
      getSessionName: () => "Dashboard test",
      getCwd: () => "/work/project-alpha",
      getSessionFile: () => opts.sessionFile,
      getHeader: () => opts.header ?? null,
      getLeafId: () => "leaf-1",
      getSessionDir: () => opts.sessionDir ?? "/tmp",
    },
    ui: {
      setWidget() {},
      setEditorComponent() {},
      getEditorComponent: () => undefined,
      addAutocompleteProvider() {},
      notify(...args: any[]) {
        notices.push(String(args[0]));
      },
    },
  } as any;
}

function createFakeProducer() {
  const snapshots: DashboardSnapshot[] = [];
  const options: DashboardProducerOptions[] = [];
  let factoryCalls = 0;
  let closeCalls = 0;
  const factory: DashboardProducerFactory = (producerOptions) => {
    factoryCalls++;
    options.push(producerOptions);
    producerOptions.onReady?.("http://127.0.0.1:4321/?token=test");
    return {
      publish(snapshot) {
        snapshots.push(structuredClone(snapshot));
      },
      close() {
        closeCalls++;
      },
    };
  };
  return {
    factory,
    snapshots,
    options,
    get factoryCalls() { return factoryCalls; },
    get closeCalls() { return closeCalls; },
    get latest() { return snapshots.at(-1); },
  };
}

function assertNoForbiddenKeys(value: unknown, path = "$"): void {
  const forbidden = new Set([
    "sessionFile", "sessionPath", "lastTail", "transcript", "transcripts", "sessionDir",
    "credentials", "apiKey", "token", "secret", "rawPrompt", "prompt", "specPath",
    "frozenCriteria", "watchdog", "stallStrikes", "launchScriptFile", "sourceSession",
  ]);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbidden.has(key), false, `forbidden dashboard field ${path}.${key}`);
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}

test("projection allowlists protocol fields and only uses explicit artifact provenance", () => {
  const rawChild = {
    id: "worker-api",
    name: "API worker",
    scope: "api",
    status: "running",
    purpose: "implementation",
    task: "Implement the API",
    handoffId: "handoff-api",
    laneFiles: ["src/api.ts"],
    lastMilestoneFiles: ["tests/api.test.ts"],
    artifactIds: ["api-contract"],
    startedAt: 1000,
    budgetMs: 2000,
    pendingPing: true,
    updatedAt: "2026-10-26T00:00:00.000Z",
    // Internal-only fields that must never cross the bridge.
    sessionFile: "/private/sessions/worker.jsonl",
    specPath: "/private/specs/api.md",
    lastTail: "TOP SECRET TERMINAL TAIL",
    stallStrikes: 3,
    frozenCriteria: ["private criterion"],
    watchdog: { trip: "stall-detected", interrupts: 1 },
    launchScriptFile: "/private/launch.sh",
    interactive: true,
    autoExit: true,
  };

  const child = projectChild(rawChild);
  assert.ok(child);
  assert.equal(child.id, "worker-api");
  assert.equal(child.laneFiles[0], "src/api.ts");
  assertNoForbiddenKeys(child);

  const orchestrator = projectOrchestrator({
    children: [rawChild],
    handoffs: new Map([["handoff-api", { record: {
      id: "handoff-api", scope: "api", goal: "Implement the API",
      acceptanceCriteria: ["tests pass", "lane respected"], laneFiles: ["src/api.ts"],
    } }]]),
    reviews: [{ id: "review-1", scope: "api", verdict: "approved", summary: "Lane clean", failedCriteria: [], inLane: true, timestamp: "2026-10-26T01:00:00.000Z" }],
    escalations: [{ id: "esc-1", childId: "worker-api", scope: "api", question: "Which theme?", stage: "orchestrator", sessionFile: "/private/sessions/worker.jsonl", childName: "API worker", history: [], askedAt: "x", updatedAt: "x" }],
    specReviews: [{ id: "sr-1", status: "collected", target: { title: "API spec" }, reviewers: [{ lens: "readiness", scope: "review-api-readiness", childId: "reviewer-api", sessionFile: "/private/sessions/reviewer.jsonl", status: "submitted", updatedAt: "x" }] }],
    paused: true,
  });

  assert.equal(orchestrator.children.length, 1);
  assert.equal(orchestrator.handoffs[0].goal, "Implement the API");
  assert.deepEqual(orchestrator.handoffs[0].acceptanceCriteria, ["tests pass", "lane respected"]);
  assert.equal(orchestrator.escalations[0].stage, "orchestrator");
  assert.deepEqual(orchestrator.specReviews[0].reviewerIds, ["reviewer-api"]);
  assert.equal(orchestrator.paused, true);
  assertNoForbiddenKeys(orchestrator);

  const records = [
    toArtifactRecord({
      id: "api-contract", title: "API contract", type: "spec", content: "# exactly preserved\n",
      version: 2, createdBy: "subagent:api", createdAt: "a", updatedAt: "b", tags: ["api"],
      scope: "api", sourceSession: "/sessions/worker.jsonl",
      // extra internal fields must be dropped, not copied
      contentHash: "deadbeef", absolutePath: "/secret",
    })!,
    toArtifactRecord({
      id: "unassociated", title: "Notes", type: "other", content: "body",
      version: 1, createdBy: "subagent:worker-api", createdAt: "a", updatedAt: "b", tags: [],
      sourceSession: "/sessions/someone-else.jsonl",
    })!,
  ];
  const artifacts = projectArtifacts(records, { childBySession: new Map([["/sessions/worker.jsonl", "worker-api"]]) });
  assert.equal(artifacts.length, 2);
  const contract = artifacts.find(artifact => artifact.id === "api-contract")!;
  assert.equal(contract.childId, "worker-api", "sourceSession is explicit provenance");
  assert.equal(contract.content, "# exactly preserved\n", "artifact body is complete");
  const unassociated = artifacts.find(artifact => artifact.id === "unassociated")!;
  assert.equal(unassociated.childId, undefined, "createdBy naming a child is not provenance");
  assertNoForbiddenKeys(artifacts);

  const snapshot = projectSnapshot({
    session: projectSession(createContext([]), "orchestrator"),
    orchestrator,
    artifacts,
  });
  assert.equal(snapshot.session.project, "project-alpha", "absolute cwd is not published");
  assert.equal(snapshot.session.mode, "orchestrator");
  assertNoForbiddenKeys(snapshot);
});

test("bridge is lazy, coalesces mutations, deduplicates re-entry, keeps observation, and releases only its producer", async () => {
  const producer = createFakeProducer();
  const errors: unknown[] = [];
  const bridge = new DashboardBridge({
    producerFactory: producer.factory,
    coalesceMs: 1,
    onError: error => errors.push(error),
  });
  bridge.setSession({ id: "s1", name: "Session", project: "alpha", mode: "normal" });
  bridge.observeMode("normal");
  assert.equal(producer.factoryCalls, 0, "loading/observing never starts a producer");

  bridge.observeMode("orchestrator");
  assert.equal(producer.factoryCalls, 0, "the mode observer is not a start signal");
  await bridge.start();
  assert.equal(producer.factoryCalls, 1);
  assert.equal(producer.snapshots.length, 1, "initial snapshot exists before any child");
  assert.equal(producer.latest!.session.mode, "orchestrator");
  assert.deepEqual(producer.latest!.orchestrator.children, []);

  // Re-entry reuses the lease.
  await bridge.start();
  assert.equal(producer.factoryCalls, 1, "re-entry must not create a second top-level session");

  const orchestrator = {
    ...emptyOrchestrator(),
    children: [{
      id: "worker-api", name: "API worker", scope: "api", status: "running" as const,
      laneFiles: ["src/api.ts"], lastMilestoneFiles: [],
    }],
    handoffs: [{ id: "handoff-api", scope: "api", goal: "Implement API", acceptanceCriteria: ["pass"] }],
  };
  bridge.observeOrchestrator(orchestrator, new Map([["/sessions/worker.jsonl", "worker-api"]]));
  bridge.observeArtifacts([toArtifactRecord({
    id: "api-contract", title: "API", type: "spec", content: "body", version: 1,
    createdBy: "main", createdAt: "a", updatedAt: "b", tags: [],
    sourceSession: "/sessions/worker.jsonl",
  })!]);
  // Two observations inside one window produce one coalesced publish.
  const beforeFlush = producer.snapshots.length;
  await delay(15);
  assert.equal(producer.snapshots.length, beforeFlush + 1, "mutations coalesce into one snapshot");
  assert.equal(producer.latest!.artifacts[0].childId, "worker-api");

  // Leaving mode publishes the actual new mode and retains the observation.
  bridge.observeMode("normal");
  await delay(15);
  assert.equal(producer.latest!.session.mode, "normal");
  assert.equal(producer.latest!.orchestrator.children.length, 1, "leaving mode keeps observing work");

  const publishedBeforeClose = producer.snapshots.length;
  await bridge.close();
  assert.equal(producer.closeCalls, 1, "shutdown releases this producer");
  bridge.observeMode("orchestrator");
  await delay(15);
  assert.equal(producer.snapshots.length, publishedBeforeClose, "a closed lease publishes nothing");
  assert.deepEqual(errors, []);
});

test("producer failures are reported, never thrown into the publisher", async () => {
  const errors: unknown[] = [];
  const bridge = new DashboardBridge({
    producerFactory: () => ({
      publish() {
        throw new Error("socket closed");
      },
      close() {},
    }),
    coalesceMs: 1,
    onError: error => errors.push(error),
  });
  bridge.setSession({ id: "s1", name: "S", project: "p", mode: "orchestrator" });
  bridge.observeMode("orchestrator");
  await bridge.start();
  assert.equal(bridge.started, true);
  assert.equal(errors.length, 1);
  bridge.flush();
  assert.equal(errors.length, 2, "publish failure is reported and swallowed");
  await bridge.close();

  let attempts = 0;
  const retrying = new DashboardBridge({
    producerFactory: () => {
      attempts++;
      throw new Error("no runtime yet");
    },
    coalesceMs: 1,
    onError: error => errors.push(error),
  });
  retrying.setSession({ id: "s2", name: "S2", project: "p", mode: "orchestrator" });
  await retrying.start();
  assert.equal(retrying.started, false, "a failed start does not look started");
  await retrying.start();
  assert.equal(attempts, 2, "a later entry can retry the lazily created runtime");
  await retrying.close();
});

test("dashboard starts only for a successful parent Orchestrator entry, not refusal or children", async () => {
  const bus = createBus();
  const producer = createFakeProducer();
  const entries: any[] = [];
  const { pi, commands, emit } = createPi(bus, entries);
  modesExtension(pi);
  dashboardExtension(pi, { producerFactory: producer.factory, coalesceMs: 1 });
  const notices: string[] = [];
  const context = createContext(entries, { notices });

  await emit("session_start", {}, context);
  assert.equal(producer.factoryCalls, 0, "Normal mode does not register a dashboard session");

  // A refused transition publishes nothing and starts nothing.
  const refusedContext = { ...context, isIdle: () => false };
  await commands.get("mode").handler("orchestrator", refusedContext);
  assert.equal(producer.factoryCalls, 0, "refused switch never creates a top-level session");

  await commands.get("mode").handler("orchestrator", context);
  assert.equal(producer.factoryCalls, 1);
  assert.equal(producer.latest!.session.mode, "orchestrator");
  assert.equal(producer.latest!.session.id, "session-parent");

  // Re-entry deduplicates.
  await commands.get("mode").handler("orchestrator", context);
  assert.equal(producer.factoryCalls, 1, "re-entering Orchestrator reuses the session");

  // Leaving publishes the new mode while keeping the lease.
  await commands.get("mode").handler("normal", context);
  await waitFor(() => producer.latest!.session.mode === "normal", "normal mode publish");
  assert.equal(producer.factoryCalls, 1);

  // A sync handshake republishes current state (loading order safety).
  const before = producer.snapshots.length;
  bus.emit(DASHBOARD_REQUEST_EVENT, {});
  await waitFor(() => producer.snapshots.length > before, "request handshake publish");

  await emit("session_shutdown", {}, context);
  assert.equal(producer.closeCalls, 1, "shutdown releases this producer");
});

test("a branch restore into Orchestrator reconnects; a seeded child never registers", async () => {
  // Restore path: the transcript says Orchestrator before session_start runs.
  const restoreEntries: any[] = [{
    id: "mode-1", type: "custom", customType: SUPERVISOR_MODE_TYPE,
    data: { enabled: true, previousTools: [], modeId: "orchestrator" }, timestamp: "x",
  }];
  const restoreBus = createBus();
  const restoredProducer = createFakeProducer();
  const restoredPi = createPi(restoreBus, restoreEntries);
  modesExtension(restoredPi.pi);
  dashboardExtension(restoredPi.pi, { producerFactory: restoredProducer.factory, coalesceMs: 1 });
  const restoreContext = createContext(restoreEntries);
  await restoredPi.emit("session_start", {}, restoreContext);
  assert.equal(restoredProducer.factoryCalls, 1, "a restored Orchestrator session reconnects");
  assert.equal(restoredProducer.latest!.session.mode, "orchestrator");
  await restoredPi.emit("session_shutdown", {}, restoreContext);

  // Seeded child: a fork marker makes this session a child even if the mode says
  // Orchestrator and the inherited branch looks like its parent's.
  const childEntries: any[] = [{
    id: "seed-1", type: "custom", customType: SUBAGENT_CONTEXT_TYPE,
    data: {
      version: 1, mode: "fork", parentSession: "/sessions/parent.jsonl", parentLeafId: "leaf",
      parentSessionId: "session-parent", seededAt: "2026-10-26T00:00:00.000Z", seededEntries: 1, seededChars: 10,
      estimatedTokens: 3, truncated: null,
    },
    timestamp: "x",
  }];
  const childBus = createBus();
  const childProducer = createFakeProducer();
  const childPi = createPi(childBus, childEntries);
  dashboardExtension(childPi.pi, { producerFactory: childProducer.factory, coalesceMs: 1 });
  const childContext = createContext(childEntries, { sessionId: "session-child" });
  await childPi.emit("session_start", {}, childContext);
  publishDashboardMode(childPi.pi as any, "orchestrator");
  await delay(10);
  assert.equal(childProducer.factoryCalls, 0, "verified/inherited children never create top-level sessions");
  await childPi.emit("session_shutdown", {}, childContext);
});

function artifactRecord(id: string, overrides: Partial<Artifact> = {}): Artifact {
  return {
    id,
    title: `Artifact ${id}`,
    type: "spec",
    content: `# ${id}\nbody`,
    version: 1,
    createdBy: "main",
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
    tags: [],
    ...overrides,
  };
}

test("unrelated parent sessions keep independent dashboard producers and catalogs", async () => {
  const busA = createBus();
  const busB = createBus();
  const producerA = createFakeProducer();
  const producerB = createFakeProducer();
  const piA = createPi(busA, []);
  const piB = createPi(busB, []);
  dashboardExtension(piA.pi, { producerFactory: producerA.factory, coalesceMs: 1 });
  dashboardExtension(piB.pi, { producerFactory: producerB.factory, coalesceMs: 1 });
  const contextA = createContext([], { sessionId: "session-a" });
  const contextB = createContext([], { sessionId: "session-b" });
  await piA.emit("session_start", {}, contextA);
  await piB.emit("session_start", {}, contextB);
  publishDashboardMode(piA.pi as any, "orchestrator");
  publishDashboardMode(piB.pi as any, "orchestrator");
  busA.emit(DASHBOARD_ARTIFACTS_EVENT, { artifacts: [toArtifactRecord({ id: "only-a", title: "A", type: "plan", content: "a", version: 1, createdBy: "main", createdAt: "x", updatedAt: "x", tags: [] })] });
  busB.emit(DASHBOARD_ARTIFACTS_EVENT, { artifacts: [toArtifactRecord({ id: "only-b", title: "B", type: "plan", content: "b", version: 1, createdBy: "main", createdAt: "x", updatedAt: "x", tags: [] })] });
  await waitFor(() => producerA.latest?.artifacts.length === 1 && producerB.latest?.artifacts.length === 1, "both sessions publish");
  assert.equal(producerA.latest!.session.id, "session-a");
  assert.equal(producerB.latest!.session.id, "session-b");
  assert.deepEqual(producerA.latest!.artifacts.map(artifact => artifact.id), ["only-a"]);
  assert.deepEqual(producerB.latest!.artifacts.map(artifact => artifact.id), ["only-b"]);
  assert.notEqual(producerA.latest, producerB.latest, "separate sessions get separate producers");
  await piA.emit("session_shutdown", {}, contextA);
  await piB.emit("session_shutdown", {}, contextB);
});

test("artifact catalog publishes effective parent/scope/sidecar/ingested state and never resurrects removals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dashboard-artifacts-"));
  const sessionFile = join(dir, "parent.jsonl");
  const childSession = join(dir, "child.jsonl");
  try {
    const bus = createBus();
    const published: any[] = [];
    bus.on(DASHBOARD_ARTIFACTS_EVENT, (notice: any) => published.push(notice.artifacts));
    const entries: any[] = [];
    const { pi, tools, emit } = createPi(bus, entries);
    artifactsExtension(pi);
    const context = createContext(entries, { sessionFile, sessionDir: dir });
    await emit("session_start", {}, context);
    assert.equal(Array.isArray(published.at(-1)), true, "session start publishes an initial catalog");

    // Branch artifact.
    await tools.get("artifact_save").execute("c1", {
      id: "global-note", title: "Global note", type: "plan", content: "global body", tags: [],
    }, undefined, undefined, context);
    assert.ok(published.at(-1)!.some((artifact: any) => artifact.id === "global-note"));

    // Scoped spec: sidecar-only, still in the effective catalog.
    await tools.get("artifact_save").execute("c2", {
      id: "api-contract", title: "API contract", type: "spec", content: "scoped body", scope: "api", tags: [],
    }, undefined, undefined, context);
    const scoped = published.at(-1)!.find((artifact: any) => artifact.id === "api-contract");
    assert.ok(scoped, "sidecar-only scoped spec is published");
    assert.equal(scoped.scope, "api");
    assert.equal(scoped.content, "scoped body");
    const sidecar = await readFile(artifactSidecarPath(sessionFile, "api-contract"), "utf8");
    assert.match(sidecar, /scoped body/);

    // Child ingestion: explicit sourceSession provenance survives to the notice.
    await writeFile(artifactSidecarPath(childSession, "child-note"), JSON.stringify(artifactRecord("child-note", {
      title: "Child note", content: "child body", sourceSession: childSession, scope: "api",
    })));
    await emit("tool_execution_end", {
      isError: false,
      toolName: "orch_spawn",
      result: { details: { sessionFile: childSession, scope: "api" } },
    }, context);
    const ingested = published.at(-1)!.find((artifact: any) => artifact.id === "child-note");
    assert.ok(ingested, "child sidecar is ingested and published");
    assert.equal(ingested.sourceSession, childSession, "provenance is kept for the bridge projection");

    // Tombstone removes it, even though the sidecar still exists on disk.
    pi.appendEntry(ARTIFACT_TYPE, { id: "api-contract", deleted: true, removedAt: "2026-10-26T01:00:00.000Z" });
    pi.appendEntry(ARTIFACT_TYPE, { id: "child-note", deleted: true, removedAt: "2026-10-26T01:00:00.000Z" });
    await emit("session_tree", {}, context);
    assert.equal(published.at(-1)!.some((artifact: any) => artifact.id === "api-contract"), false,
      "a tombstoned sidecar-only spec is not resurrected");
    assert.equal(published.at(-1)!.some((artifact: any) => artifact.id === "child-note"), false,
      "a tombstoned ingested artifact is not resurrected");

    // Re-ingest the same child directory: the removal still wins.
    await emit("tool_execution_end", {
      isError: false,
      toolName: "orch_spawn",
      result: { details: { sessionFile: childSession, scope: "api" } },
    }, context);
    assert.equal(published.at(-1)!.some((artifact: any) => artifact.id === "child-note"), false,
      "watcher/re-ingestion cannot undo a removal");

    // A removal marker (compacted transcript) also wins over a surviving sidecar.
    await tools.get("artifact_save").execute("c3", {
      id: "kept-spec", title: "Kept", type: "spec", content: "kept body", scope: "api", tags: [],
    }, undefined, undefined, context);
    await writeFile(`${sessionFile}.artifact-removals.json`, JSON.stringify(["kept-spec"]));
    await emit("session_tree", {}, context);
    assert.equal(published.at(-1)!.some((artifact: any) => artifact.id === "kept-spec"), false,
      "removal marker removes a branch artifact");

    // A sync handshake republishes even when nothing changed.
    const before = published.length;
    bus.emit(DASHBOARD_SYNC_EVENT, {});
    assert.ok(published.length > before, "artifact publisher answers the dashboard handshake");
    await emit("session_shutdown", {}, context);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("orchestrator publishes allowlisted state and answers the dashboard handshake", async (t) => {
  let module: any;
  try {
    module = await import("../extensions/orchestrator.ts");
  } catch (error: any) {
    t.skip(`legacy host imports unavailable in this run: ${String(error?.message ?? error).slice(0, 120)}`);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "dashboard-orchestrator-"));
  try {
    module.registry.resetForTests();
    module.handoffs.clear();
    module.specReviews.clear();
    const childSession = join(dir, "worker.jsonl");
    module.registry.registerChild({
      id: "worker-api", name: "API worker", scope: "api", sessionFile: childSession,
      status: "running", laneFiles: ["src/api.ts"], lastMilestoneFiles: ["tests/api.test.ts"],
      handoffId: "handoff-api", task: "Implement the API", startedAt: 1, budgetMs: 1000,
      lastTail: "PRIVATE TERMINAL TAIL", specPath: "/private/spec.md",
      updatedAt: "2026-10-26T00:00:00.000Z",
    });
    module.handoffs.set("handoff-api", { record: {
      id: "handoff-api", scope: "api", goal: "Implement the API",
      acceptanceCriteria: ["tests pass"], laneFiles: ["src/api.ts"], revision: 1,
      artifactId: "handoff-api-art", authoredAt: "x", parentSessionId: "session-parent",
    }, path: "/private/handoff.md" });
    module.escalations.open({
      id: "esc-1", childId: "worker-api", childName: "API worker", scope: "api",
      sessionFile: childSession, question: "Which theme?",
    });

    const bus = createBus();
    const states: any[] = [];
    bus.on(DASHBOARD_STATE_EVENT, (notice: any) => states.push(notice));
    const { pi, emit, entries } = createPi(bus, []);
    const client = { paneList: async () => [], paneGet: async () => null } as any;
    const stream = { watch: () => () => {}, onReconcile: () => () => {} };
    module.default(pi, { client, stream, now: () => 1_000_000, watchdogIntervalMs: 60_000 });
    const notices: string[] = [];
    const context = createContext(entries, { sessionDir: dir, sessionFile: join(dir, "parent.jsonl"), notices });
    await emit("session_start", {}, context);
    assert.ok(states.length >= 1, "session restore publishes orchestrator state");
    const first = states.at(-1);
    assert.equal(first.orchestrator.children.length, 1);
    assert.equal(first.orchestrator.handoffs[0].goal, "Implement the API");
    assert.equal(first.orchestrator.escalations[0].question, "Which theme?");
    assert.equal(first.childSessions.get(childSession), "worker-api", "session provenance is explicit");
    assertNoForbiddenKeys(first.orchestrator);
    assertNoForbiddenKeys(first.childSessions);

    // Mutation + handshake: the published view is current, not a persisted lag.
    module.registry.updateStatus(childSession, "completed");
    bus.emit(DASHBOARD_SYNC_EVENT, {});
    assert.equal(states.at(-1).orchestrator.children[0].status, "completed");
    await emit("session_shutdown", {}, context);
  } finally {
    module?.registry?.resetForTests?.();
    await rm(dir, { recursive: true, force: true });
  }
});
