import {
  checkAndSeedFixtures,
  getPluginsRevision,
  subscribePluginChanges,
} from "@/lib/web-plugins-host";

export const dynamic = "force-dynamic";

// GET /api/plugins/events - SSE change notification channel for workflow web plugins.
// Immediately streams the current store revision on connection, then notifies
// connected clients with { type: "changed", revision } whenever views change.
export async function GET(req: Request) {
  if (req.signal.aborted) {
    return new Response(null, { status: 204 });
  }

  checkAndSeedFixtures();

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      function cleanup() {
        if (closed) return;
        closed = true;
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (unsubscribe) {
          try {
            unsubscribe();
          } catch {
            // Ignore unsubscribe errors
          }
          unsubscribe = null;
        }
        try {
          controller.close();
        } catch {
          // Stream might already be closed
        }
      }

      function send(payload: { type: string; revision: number }) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          cleanup();
        }
      }

      function ping() {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }

      req.signal.addEventListener("abort", cleanup, { once: true });
      if (req.signal.aborted) {
        cleanup();
        return;
      }

      // Initial state push immediately upon connection
      send({ type: "changed", revision: getPluginsRevision() });

      // Subscribe to subsequent store updates
      unsubscribe = subscribePluginChanges((revision) => {
        send({ type: "changed", revision });
      });

      // 15s heartbeat comment to keep the connection alive through intermediate proxies
      heartbeat = setInterval(ping, 15_000);
    },
    cancel() {
      if (closed) return;
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {
          // Ignore
        }
        unsubscribe = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
