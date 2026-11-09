import { NextResponse } from "next/server";
import {
  checkAndSetInFlightAction,
  getPluginDescriptor,
  isKnownSession,
  recordActionAudit,
  relayActionRequest,
} from "@/lib/web-plugins-host";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: {
    sessionId?: unknown;
    pluginId?: unknown;
    actionId?: unknown;
    confirm?: unknown;
  };

  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sessionId, pluginId, actionId, confirm } = body ?? {};

  // 1. Validate: sessionId/pluginId/actionId known (404 before anything else)
  if (typeof sessionId !== "string" || !isKnownSession(sessionId)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (typeof pluginId !== "string") {
    return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
  }

  const descriptor = getPluginDescriptor(pluginId);
  if (!descriptor) {
    return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
  }

  if (typeof actionId !== "string") {
    return NextResponse.json({ error: "Action not found" }, { status: 404 });
  }

  const action = descriptor.actions?.find((a) => a.id === actionId);
  if (!action) {
    return NextResponse.json({ error: "Action not found" }, { status: 404 });
  }

  // 2. Validate: a declared confirm must match byte-identically (403, nothing emitted).
  //    An action without a declared confirm is the instant form the plugin-actions
  //    PRD names per action; it submits without a typed string.
  if (action.confirm !== undefined && (typeof confirm !== "string" || confirm !== action.confirm)) {
    return NextResponse.json({ error: "Invalid confirmation string" }, { status: 403 });
  }

  // 3. Validate: at most one in-flight action per sessionId held for 60s (409, A6)
  const requestId = crypto.randomUUID();
  if (!checkAndSetInFlightAction(sessionId, requestId, 60_000)) {
    return NextResponse.json(
      { error: "Action already in flight for this session" },
      { status: 409 },
    );
  }

  // 4. On success:
  const timestamp = Date.now();
  recordActionAudit({
    requestId,
    sessionId,
    pluginId,
    actionId,
    timestamp,
  });

  const { relayed } = relayActionRequest(sessionId, pluginId, actionId, requestId);

  return NextResponse.json({ ok: true, requestId, relayed });
}
