/** Manual browser-verification fixture; never loaded by production extensions.
 * node --experimental-strip-types tests/fixtures/dashboard-browser-fixture.ts <private-temp-dir>
 * Writes ready.json (browser URL) and accepts { action } via control.json:
 * rename-session (with title), complete-worker, update-artifact, remove-artifact, disconnect-first, shutdown.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { DashboardProducer } from "../../lib/dashboard/producer.ts";
import { emptyDelegation, type DashboardSnapshot } from "../../lib/dashboard/protocol.ts";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a private temporary fixture directory");
await mkdir(directory, { recursive: true, mode: 0o700 });
const runtimeDir = join(directory, "runtime");
const timestamp = new Date().toISOString();
const first: DashboardSnapshot = {
  session: { id: "browser-fixture-a", name: "Dashboard verification", project: "Project Atlas", mode: "orchestrator", branchId: "branch-a" },
  delegation: {
    ...emptyDelegation(),
    children: [
      { id: "worker-api", name: "API worker", scope: "api", status: "running", purpose: "implementation", task: "Implement the API contract", handoffId: "handoff-api", laneFiles: ["src/api.ts"], lastMilestoneFiles: ["tests/api.test.ts"], artifactIds: ["api-contract"], startedAt: Date.now(), budgetMs: 1800000 },
      { id: "worker-ui", name: "UI worker", scope: "ui", status: "blocked", purpose: "implementation", task: "Build the web interface", laneFiles: ["src/ui.ts"], lastMilestoneFiles: [], pendingPing: true },
      { id: "reviewer-api", name: "Contract reviewer", scope: "review-api", status: "running", purpose: "review", reviewRunId: "review-run-api", reviewLens: "readiness", laneFiles: [], lastMilestoneFiles: [] },
    ],
    handoffs: [{ id: "handoff-api", scope: "api", goal: "Implement API contract", acceptanceCriteria: ["API contract tests pass", "Worker stays inside declared lane"] }],
    escalations: [{ id: "question-ui", childId: "worker-ui", scope: "ui", question: "Which theme should the UI use?", stage: "orchestrator" }],
    specReviews: [{ id: "review-run-api", title: "API specification", status: "reviewing", reviewerIds: ["reviewer-api"] }],
  },
  artifacts: [
    { id: "api-contract", title: "API contract", type: "spec", content: "# API contract\n\nLive artifact from the **API worker**.\n\n| Endpoint | Result |\n| --- | --- |\n| GET /health | Ready |\n\n```typescript\nexport const ready = true;\n```\n\n[Documentation](https://example.com)\n\n<script>window.fixtureInjected = true</script>\n\n![Remote image](https://example.com/tracker.png)\n", version: 1, createdBy: "subagent:api", createdAt: timestamp, updatedAt: timestamp, tags: ["api", "contract"], scope: "api", childId: "worker-api" },
    { id: "sample-code", title: "Health handler", type: "code", content: "export function health(): { ready: boolean } {\n  return { ready: true };\n}\n", version: 1, createdBy: "main", createdAt: timestamp, updatedAt: timestamp, tags: ["typescript"] },
  ],
};
const second: DashboardSnapshot = {
  session: { id: "browser-fixture-b", name: "Independent orchestration", project: "Project Beacon", mode: "orchestrator", branchId: "branch-b" },
  delegation: { ...emptyDelegation(), children: [{ id: "worker-docs", name: "Documentation worker", scope: "docs", status: "completed", task: "Document the independent project", laneFiles: ["README.md"], lastMilestoneFiles: ["README.md"] }] },
  artifacts: [{ id: "independent-note", title: "Beacon notes", type: "plan", content: "# Independent session\n\nThis artifact belongs only to **Project Beacon**.\n", version: 1, createdBy: "main", createdAt: timestamp, updatedAt: timestamp, tags: [] }],
};
let written = false;
const onReady = (url: string) => {
  if (written) return;
  written = true;
  void writeFile(join(directory, "ready.json"), JSON.stringify({ url }), { mode: 0o600 });
};
const a = new DashboardProducer({ runtimeDir, heartbeatMs: 1000, onReady });
const b = new DashboardProducer({ runtimeDir, heartbeatMs: 1000, onReady });
a.publish(first);
b.publish(second);
let lastCommand = "";
let closed = false;
async function stop() {
  if (closed) return;
  closed = true;
  watcher.close();
  await Promise.all([a.close(), b.close()]);
  process.exitCode = 0;
}
async function command() {
  let raw: string;
  try { raw = await readFile(join(directory, "control.json"), "utf8"); } catch { return; }
  if (raw === lastCommand) return;
  lastCommand = raw;
  const { action, title } = JSON.parse(raw);
  if (action === "rename-session") {
    if (typeof title !== "string" || !title.trim()) throw new Error("rename-session requires title");
    first.session.name = title.trim();
    a.publish(structuredClone(first));
  } else if (action === "complete-worker") {
    first.delegation.children[0].status = "completed";
    first.delegation.reviews = [{ id: "review-api", scope: "api", verdict: "approved", summary: "Contract tests passed", timestamp: new Date().toISOString() }];
    a.publish(structuredClone(first));
  } else if (action === "update-artifact") {
    first.artifacts[0].version++;
    first.artifacts[0].updatedAt = new Date().toISOString();
    first.artifacts[0].content = "# API contract — updated\n\nThis is **version 2**, delivered live without a page reload.\n\n- GET /health: ready\n- GET /api: documented\n";
    a.publish(structuredClone(first));
  } else if (action === "remove-artifact") {
    first.artifacts = first.artifacts.filter(item => item.id !== "api-contract");
    a.publish(structuredClone(first));
  } else if (action === "disconnect-first") {
    await a.close();
  } else if (action === "shutdown") {
    await stop();
  }
  await writeFile(join(directory, "ack.json"), JSON.stringify({ action }), { mode: 0o600 });
}
const watcher = watch(directory, (_event, filename) => {
  if (filename?.toString() === "control.json") void command().catch(error => console.error(String(error)));
});
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
