#!/usr/bin/env node
/**
 * Optional local preview server for the dashboard UI (development only).
 *
 * The production runtime serves the same routes from `lib/dashboard/`; this
 * harness exists so the UI can be exercised without a live Pi session. It has
 * no authentication and must never be exposed beyond localhost.
 *
 *   node scripts/dev-dashboard.mjs [--port 4789]
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(new URL("../web/dashboard/", import.meta.url)));
const dashboardDir = here;
const portArgIndex = process.argv.indexOf("--port");
const port = Number(portArgIndex > 0 ? process.argv[portArgIndex + 1] : process.env.PORT || 4789);

const now = Date.now();
const ago = (minutes) => now - minutes * 60_000;
const stamp = (minutes) => new Date(ago(minutes)).toISOString();

function artifact(id, title, type, version, content, extra = {}) {
  return {
    id,
    title,
    type,
    version,
    createdBy: extra.childId || "session",
    createdAt: stamp(extra.createdMinutes ?? 180),
    updatedAt: stamp(extra.updatedMinutes ?? 4),
    tags: extra.tags || [],
    ...(extra.scope ? { scope: extra.scope } : {}),
    ...(extra.childId ? { childId: extra.childId } : {}),
    content,
  };
}

const artifacts = {
  "spec-api": artifact(
    "spec-api",
    "API contract",
    "spec",
    2,
    [
      "# API contract",
      "",
      "> Read-only preview of the handoff behind the dashboard API.",
      "",
      "| Endpoint | Shape | Status |",
      "| --- | --- | --- |",
      "| `GET /api/sessions` | `{ sessions }` | ready |",
      "| `GET /api/session` | `{ session }` | ready |",
      "| `GET /api/artifact` | `{ artifact }` | ready |",
      "| `GET /api/events` | SSE `{ type: \"changed\" }` | ready |",
      "",
      "```js",
      "const response = await fetch('/api/session?id=' + encodeURIComponent(id));",
      "const { session } = await response.json();",
      "```",
      "",
      "Unsafe content must stay inert (fixture payloads, no network access):",
      "",
      "<script>window.__pwned = true</script>",
      '<img src="tracking-pixel.png" alt="tracking pixel" onerror="alert(1)">',
      "",
      "[bad link](javascript:alert(1)) [safe relative link](/docs/overview) [file link](file:///etc/passwd)",
      "",
      "- [x] version-aware fetch",
      "- [x] sanitize rendered markdown",
      "- [ ] replace the fixture with the real runtime",
    ].join("\n"),
    { tags: ["api", "contract"], scope: "api", childId: "c-api", updatedMinutes: 3 },
  ),
  "review-api": artifact(
    "review-api",
    "Security review — dashboard API",
    "review",
    1,
    [
      "# Security review — dashboard API",
      "",
      "**Verdict:** approved",
      "",
      "## What held up",
      "",
      "- Artifact bodies are only served on an exact version match; otherwise `409`.",
      "- The event stream carries no payload beyond a change hint.",
      "- Unknown session and artifact ids both answer `404` with a JSON error.",
      "",
      "## Follow-ups",
      "",
      "- Cover the blocked worker's drawer fetch in the browser tests.",
    ].join("\n"),
    { tags: ["review", "security"], scope: "api", childId: "c-review", createdMinutes: 40, updatedMinutes: 12 },
  ),
  "code-worker": artifact(
    "code-worker",
    "Drawer and work list notes",
    "code",
    3,
    [
      "## Drawer and work list notes",
      "",
      "```js",
      "const groups = ['attention', 'progress', 'finished'];",
      "for (const group of groups) render(group, itemsByGroup[group]);",
      "```",
      "",
      "```yaml",
      "dashboard:",
      "  tabs: [work, artifacts]",
      "  views: [list, graph]",
      "  drawer: handoff-goal-and-criteria",
      "```",
    ].join("\n"),
    { tags: ["ui", "drawer"], scope: "ui", childId: "c-ui", updatedMinutes: 2 },
  ),
  "preview-fixtures": artifact(
    "preview-fixtures",
    "Preview fixture checklist",
    "note",
    2,
    [
      "# Preview fixture checklist",
      "",
      "The dev preview must exercise every drawer state without a live session.",
      "",
      "- [x] three handoffs with wrapping goals and real criteria",
      "- [x] running, completed and blocked workers linked by `handoffId`",
      "- [x] one worker waiting on a pending question",
      "- [x] one escalation, one approved review, one spec review",
      "- [x] a second paused, offline session with empty collections",
    ].join("\n"),
    { tags: ["fixtures", "docs"], scope: "fixtures", childId: "c-fixture", createdMinutes: 150, updatedMinutes: 18 },
  ),
  "notes-session": artifact(
    "notes-session",
    "Session notes",
    "note",
    1,
    [
      "# Session notes",
      "",
      "This artifact has no `childId`, so it is associated with the session, not a worker.",
      "",
      "```bash",
      "npm run build:dashboard",
      "node scripts/dev-dashboard.mjs --port 4789",
      "```",
      "",
      "## Open question",
      "",
      "Worker `c-blocked` asked whether the drawer should block a fetch when the catalog version moved.",
    ].join("\n"),
    { scope: "session", tags: ["notes"], createdMinutes: 200, updatedMinutes: 25 },
  ),
};

const sessions = {
  "demo-alpha": {
    session: { id: "demo-alpha", name: "Alpha implementation", project: "pi-workflow-extensions", mode: "normal", branchId: "main" },
    connected: true,
    lastSeen: now,
    revision: 7,
    orchestrator: {
      paused: false,
      children: [
        {
          id: "c-api",
          name: "api-worker",
          scope: "api",
          status: "running",
          purpose: "implementation",
          task: "Implement the dashboard API and the SSE refresh path.",
          handoffId: "h-api",
          reviewRunId: "sr-1",
          laneFiles: [
            "lib/dashboard/protocol.ts",
            "lib/dashboard/producer.ts",
            "lib/dashboard/server.ts",
          ],
          lastMilestoneFiles: ["lib/dashboard/server.ts", "tests/dashboard-web.test.ts"],
          artifactIds: ["spec-api"],
          supersededIds: ["c-legacy"],
          startedAt: ago(58),
          updatedAt: stamp(2),
          budgetMs: 45 * 60_000,
          lastTokens: 41_300,
          lastContextWindow: 200_000,
        },
        {
          id: "c-ui",
          name: '</text><script>alert("xss")</script>',
          scope: "ui",
          status: "running",
          purpose: "implementation",
          task: "Rebuild the Work tab: grouped list, graph toggle and the detail drawer.",
          handoffId: "h-ui",
          laneFiles: ["web/dashboard/index.html", "web/dashboard/style.css", "web/dashboard/src/app.mjs"],
          lastMilestoneFiles: ["web/dashboard/src/graph.mjs", "web/dashboard/src/state.mjs"],
          artifactIds: ["code-worker"],
          startedAt: ago(51),
          pendingPing: true,
          updatedAt: stamp(1),
          budgetMs: 60 * 60_000,
          lastTokens: 52_900,
          lastContextWindow: 200_000,
        },
        {
          id: "c-fixture",
          name: "preview-worker",
          scope: "fixtures",
          status: "completed",
          purpose: "implementation",
          task: "Refresh the preview fixtures so every drawer state is reachable.",
          handoffId: "h-fixture",
          laneFiles: ["scripts/dev-dashboard.mjs"],
          lastMilestoneFiles: ["scripts/dev-dashboard.mjs", "web/dashboard/README.md"],
          artifactIds: ["preview-fixtures"],
          startedAt: ago(96),
          updatedAt: stamp(14),
          closeReason: "completed",
          lastTokens: 28_400,
          lastContextWindow: 200_000,
        },
        {
          id: "c-blocked",
          name: "drawer-worker",
          scope: "api",
          status: "blocked",
          purpose: "implementation",
          task: "Wire the artifact version guard into the drawer's fetch path.",
          handoffId: "h-api",
          reviewRunId: "sr-1",
          laneFiles: ["lib/dashboard/server.ts"],
          lastMilestoneFiles: [],
          startedAt: ago(63),
          updatedAt: stamp(9),
          budgetMs: 40 * 60_000,
          lastTokens: 17_800,
          lastContextWindow: 200_000,
        },
        {
          id: "c-review",
          name: "review-worker",
          scope: "api",
          status: "completed",
          purpose: "review",
          task: "Independent security review of the dashboard API.",
          reviewRunId: "sr-1",
          reviewLens: "security",
          laneFiles: [],
          lastMilestoneFiles: [],
          artifactIds: ["review-api"],
          startedAt: ago(74),
          updatedAt: stamp(11),
          closeReason: "approved",
        },
        {
          id: "c-legacy",
          name: "api-worker-legacy",
          scope: "api",
          status: "closed",
          purpose: "implementation",
          task: "First pass at the dashboard API before the contract rework.",
          handoffId: "h-api",
          laneFiles: [],
          lastMilestoneFiles: [],
          startedAt: ago(188),
          updatedAt: stamp(120),
          closeReason: "superseded by c-api",
        },
      ],
      handoffs: [
        {
          id: "h-api",
          scope: "api",
          goal: "Serve the read-only dashboard API: session summaries, one full session view, version-guarded artifact fetches and a single coalesced change stream that never lets a slow client miss a revision.",
          acceptanceCriteria: [
            "`GET /api/sessions` returns every known session summary, most recently seen first, with a running/total worker count.",
            "`GET /api/session?id=…` returns the orchestrator view with artifact bodies stripped down to summaries.",
            "`GET /api/artifact` answers `409` when the caller's `version` no longer matches the catalog, and `404` for unknown ids.",
            "`GET /api/events` coalesces a burst of publishes into one `{ type: \"changed\" }` message per tick.",
            "Every error is JSON `{ error }` and no route mutates state.",
          ],
        },
        {
          id: "h-ui",
          scope: "ui",
          goal: "Rebuild the dashboard around a single work list: group items into needs attention, in progress and finished, keep the graph behind the same list/graph toggle, and open one detail drawer for whatever the user clicks instead of a second inspector column.",
          acceptanceCriteria: [
            "The Work tab renders Needs attention, In progress and Finished groups and skips groups that have no items.",
            "The List/Graph toggle preserves the selected item and leaves an open drawer open.",
            "Clicking a list row or a graph node opens the drawer without changing tabs.",
            "The drawer shows the linked handoff's goal and every acceptance criterion exactly as the handoff provides it.",
            "`Esc`, the close button and the backdrop all close the drawer and return focus to whatever opened it.",
          ],
        },
        {
          id: "h-fixture",
          scope: "fixtures",
          goal: "Keep the local preview honest: fixtures that reach every drawer state without a live session, and a README that describes the sessions nav, the Work and Artifacts tabs, the list/graph toggle and the detail drawer as the UI actually behaves.",
          acceptanceCriteria: [
            "The preview shows running, completed and blocked workers linked to their handoffs, plus one worker waiting on a pending question.",
            "At least three handoffs carry real acceptance criteria and goals long enough to wrap inside the drawer.",
            "Artifacts are linked to the workers that produced them, and one artifact stays session-scoped.",
            "The README documents the Work/Artifacts tabs and no longer mentions an inspector column, an Overview tab, protocol numbers, count chips or a Rendered/Raw toggle.",
          ],
        },
      ],
      reviews: [
        {
          id: "r-1",
          scope: "api",
          verdict: "approved",
          summary: "Contract matches the runtime: same four routes, version guard on the artifact fetch, coalesced change stream.",
          timestamp: stamp(12),
        },
        {
          id: "r-2",
          scope: "ui",
          verdict: "changes-requested",
          summary: "The drawer covers the goal, but the blocked worker's fetch path still needs a browser test.",
          timestamp: stamp(8),
        },
      ],
      escalations: [
        {
          id: "e-1",
          childId: "c-blocked",
          scope: "api",
          question: "When the catalog version moved while the drawer is open, should the fetch fail closed with a 'Load latest' action, or keep the last body and mark it stale?",
          stage: "waiting",
        },
        {
          id: "e-2",
          childId: "c-ui",
          scope: "ui",
          question: "Below 720px should the drawer cover the full width, or should the list collapse into a single row of chips first?",
          stage: "answered",
        },
      ],
      specReviews: [
        { id: "sr-1", title: "Dashboard API contract", status: "ready", reviewerIds: ["c-review"] },
        { id: "sr-2", title: "Detail drawer behaviour", status: "collecting", reviewerIds: ["c-review", "c-fixture"] },
      ],
    },
    artifacts,
  },
  "demo-beta": {
    // A second project on purpose: the manager label is project-derived, so the
    // preview must show two distinct authorities, not two identical labels.
    session: { id: "demo-beta", name: "Docs refresh", project: "docs-site", mode: "plan", branchId: "docs" },
    connected: false,
    lastSeen: ago(180),
    revision: 1,
    orchestrator: { paused: true, children: [], handoffs: [], reviews: [], escalations: [], specReviews: [] },
    artifacts: {},
  },
};

function summaryOf(view) {
  return {
    ...view.session,
    connected: view.connected,
    lastSeen: view.lastSeen,
    revision: view.revision,
    workers: {
      running: view.orchestrator.children.filter((child) => child.status === "running").length,
      total: view.orchestrator.children.length,
    },
  };
}

function viewOf(view) {
  return {
    ...view,
    artifacts: Object.values(view.artifacts).map(({ content: _content, ...summary }) => summary),
  };
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(response, pathname) {
  let relative;
  if (pathname === "/" || pathname === "/index.html") relative = "index.html";
  else if (pathname === "/style.css") relative = "style.css";
  else if (pathname.startsWith("/dist/")) relative = pathname.slice(1);
  else {
    json(response, 404, { error: "Not found" });
    return;
  }
  const absolute = normalize(join(dashboardDir, relative));
  if (!absolute.startsWith(dashboardDir + sep)) {
    json(response, 403, { error: "Forbidden" });
    return;
  }
  try {
    const body = await readFile(absolute);
    response.writeHead(200, {
      "content-type": types[extname(absolute)] || "application/octet-stream",
      "cache-control": "no-store",
      "content-length": body.length,
    });
    response.end(body);
  } catch {
    json(response, 404, { error: "Not built. Run npm run build:dashboard first." });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  const { pathname } = url;

  if (pathname === "/api/sessions") {
    json(response, 200, { sessions: Object.values(sessions).map(summaryOf) });
    return;
  }
  if (pathname === "/api/session") {
    const view = sessions[url.searchParams.get("id")];
    if (!view) {
      json(response, 404, { error: "Unknown session" });
      return;
    }
    json(response, 200, { session: viewOf(view) });
    return;
  }
  if (pathname === "/api/artifact") {
    const view = sessions[url.searchParams.get("session")];
    if (!view) {
      json(response, 404, { error: "Unknown session" });
      return;
    }
    const full = view.artifacts[url.searchParams.get("id")];
    if (!full) {
      json(response, 404, { error: "Unknown artifact" });
      return;
    }
    const version = url.searchParams.get("version");
    if (version !== null && Number(version) !== Number(full.version)) {
      json(response, 409, { error: `Artifact changed (current version ${full.version})` });
      return;
    }
    json(response, 200, { artifact: full });
    return;
  }
  if (pathname === "/api/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write("retry: 2000\n\n");
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    request.on("close", () => clearInterval(heartbeat));
    return;
  }
  if (pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }
  await serveStatic(response, pathname);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`dashboard preview: http://127.0.0.1:${port}/`);
  console.log("development-only mock API; run `npm run build:dashboard` first.");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
