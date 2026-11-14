// Action bookkeeping: the in-flight claim that stops a double submit, and the
// bounded audit trail of what was requested.
//
// This is the only state an action needs, kept apart from the session bridge so
// the view store can release a claim when the handler answers: a plugin that
// publishes a new view has demonstrably handled its action.

export interface ActionAuditEntry {
  requestId: string;
  sessionId: string;
  pluginId: string;
  actionId: string;
  timestamp: number;
}

interface InFlightClaimRecord {
  requestId: string;
  expiresAt: number;
}

/**
 * How long a declared action stays locked, per (session, plugin, action). Long
 * enough to swallow a double submit, short enough that a handler which never
 * answers cannot wedge the button for the rest of the session.
 */
export const IN_FLIGHT_ACTION_TTL_MS = 10_000;
const AUDIT_LOG_LIMIT = 500;

const inFlight = new Map<string, InFlightClaimRecord>();
const auditLog: ActionAuditEntry[] = [];

/** One declared action submission: what to lock, and for how long. */
export interface InFlightClaim {
  sessionId: string;
  pluginId: string;
  actionId: string;
  requestId: string;
  ttlMs?: number;
}

function claimKey(sessionId: string, pluginId: string, actionId: string): string {
  return `${sessionId}\u0000${pluginId}\u0000${actionId}`;
}

/**
 * Claim the in-flight slot for a declared action. False while an earlier
 * submission of the *same* action is still held; a different action in the same
 * session is never blocked.
 */
export function checkAndSetInFlightAction(claim: InFlightClaim): boolean {
  const now = Date.now();
  const key = claimKey(claim.sessionId, claim.pluginId, claim.actionId);
  const current = inFlight.get(key);
  if (current !== undefined && current.expiresAt > now) return false;
  const ttlMs = claim.ttlMs ?? IN_FLIGHT_ACTION_TTL_MS;
  inFlight.set(key, { requestId: claim.requestId, expiresAt: now + ttlMs });
  return true;
}

function releaseWhere(predicate: (key: string) => boolean): void {
  for (const key of inFlight.keys()) {
    if (predicate(key)) inFlight.delete(key);
  }
}

/** Release every claim a session holds (session detached, or it shut down). */
export function releaseInFlightActions(sessionId: string): void {
  releaseWhere((key) => key.startsWith(`${sessionId}\u0000`));
}

/** Release the claims one plugin held for a session: it answered. */
export function releasePluginActions(sessionId: string, pluginId: string): void {
  releaseWhere((key) => key.startsWith(`${sessionId}\u0000${pluginId}\u0000`));
}

export function recordActionAudit(entry: ActionAuditEntry): void {
  auditLog.push(entry);
  if (auditLog.length > AUDIT_LOG_LIMIT) auditLog.splice(0, auditLog.length - AUDIT_LOG_LIMIT);
}

export function getActionAuditLog(): readonly ActionAuditEntry[] {
  return auditLog;
}

/** Test-only reset. */
export function clearActionState(): void {
  inFlight.clear();
  auditLog.length = 0;
}
