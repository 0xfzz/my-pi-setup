/**
 * Structured child messaging protocol for Pi Herdr subagents.
 *
 * Implements additive, backwards-compatible structured reporting from child to watcher.
 * Enables autonomous children and reviewers to transmit typed defect reports and
 * completion summaries via the filesystem sidecar protocol without requiring prose parsing.
 *
 * Key guarantees & security boundaries:
 * 1. Source identity is NEVER trusted from caller-supplied claims in the payload (e.g. `from`).
 *    It is authenticated and stamped by the watcher using authoritative runtime tracking (`running`),
 *    or resolved in-process from trusted runtime environment / session headers.
 * 2. Bounds are strictly enforced on all strings, numbers, and arrays to prevent oversized payloads.
 * 3. Legacy sidecars ({ type: "done" } and { type: "ping", name, message }) remain 100% compatible.
 * 4. Invalid typed payloads are explicitly rejected with validation errors rather than silently downgraded.
 * 5. Run IDs are stamped for sidecar disambiguation to protect against stale sidecar pickup on session reuse.
 *
 * Transport acknowledgment limitations:
 * The Herdr child .exit sidecar is an at-most-once filesystem signaling protocol.
 * Delivery of the sidecar by the child does NOT constitute application-level receipt,
 * acceptance, or verification by the parent orchestrator. The child writes the file and
 * self-terminates; if the filesystem drops the file, the parent watcher process is offline,
 * or the file is corrupted before classification, delivery is lost without retransmission.
 */

import { randomUUID } from "node:crypto";

export type ChildDefectSeverity = "blocker" | "major" | "nit";

export interface ChildDefectReport {
  /** Target scope / work-unit slug where the defect was observed. */
  scope?: string;
  /** Acceptance criterion identifier or title that was violated. */
  criterionId?: string;
  /** Repo-relative file path where the defect exists. */
  file?: string;
  /** 1-based line number if applicable. */
  line?: number;
  /** Expected behavior or contract. */
  expected: string;
  /** Observed defect or failure. */
  observed: string;
  /** Severity classification. Defaults to 'major' if omitted. */
  severity?: ChildDefectSeverity;
}

export interface ChildCriteriaResult {
  criterion: string;
  passed: boolean;
  evidence?: string;
}

export interface ChildCompletionReport {
  /** Overall outcome status. */
  status?: "ok" | "partial" | "failed";
  /** Repo-relative paths modified or created by the child. */
  filesTouched?: string[];
  /** Individual criterion evaluations if available. */
  criteriaNotes?: ChildCriteriaResult[];
}

export interface ChildMessageCorrelation {
  /** Unique identifier for this message. */
  messageId: string;
  /** Identifier of the message being replied to (e.g. steer or escalation prompt). */
  replyTo?: string;
  /** Stamped run ID of the child process. */
  runId?: string;
  /** 1-based attempt or turn counter. */
  attempt?: number;
}

export interface ChildSourceIdentity {
  /** Authenticated child ID from the parent's running state or env. */
  childId: string;
  /** Authenticated work-unit scope. */
  scope?: string;
  /** Child display name. */
  name: string;
  /** Session file path. */
  sessionFile: string;
}

export interface ChildPingPayload {
  type: "ping";
  name: string;
  message: string;
  defect?: ChildDefectReport;
  correlation?: ChildMessageCorrelation;
  runId?: string;
  schemaVersion?: 1;
}

export interface ChildDonePayload {
  type: "done";
  report?: ChildCompletionReport;
  correlation?: ChildMessageCorrelation;
  runId?: string;
  schemaVersion?: 1;
}

export type ExitSidecarData = ChildPingPayload | ChildDonePayload;

export const PROTOCOL_LIMITS = {
  MAX_MESSAGE_CHARS: 16_000,
  MAX_DEFECT_TEXT_CHARS: 4_000,
  MAX_SCOPE_CHARS: 100,
  MAX_CRITERION_ID_CHARS: 100,
  MAX_FILE_PATH_CHARS: 500,
  MAX_LINE_NUMBER: 1_000_000,
  MAX_ID_CHARS: 128,
  MAX_TOUCHED_FILES: 100,
  MAX_CRITERIA_NOTES: 50,
  MAX_ATTEMPT: 1_000,
} as const;

export const CHILD_PROTOCOL_TRANSPORT_LIMITATIONS =
  "Herdr child sidecar protocol is an at-most-once, one-way filesystem signaling mechanism. " +
  "Writing an .exit sidecar does not provide application-level delivery acknowledgement, " +
  "authentication of caller content, or guarantee that the parent orchestrator has processed the event.";

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

/**
 * Validates a child defect report against bounds and type rules.
 * Any untrusted identity fields (such as `from` or `caller`) are rejected or stripped.
 */
export function validateDefectReport(raw: unknown): ValidationResult<ChildDefectReport> {
  if (!isObject(raw)) {
    return { ok: false, error: "Defect report must be a non-null object" };
  }

  // Reject callers attempting to supply trusted source identity in payload
  if ("from" in raw || "caller" in raw) {
    return {
      ok: false,
      error: "Defect report may not specify 'from' or 'caller'; source identity is derived from trusted session/env",
    };
  }

  const { expected, observed, scope, criterionId, file, line, severity } = raw;

  if (typeof expected !== "string" || expected.trim() === "") {
    return { ok: false, error: "Defect expected behavior must be a non-empty string" };
  }
  if (expected.length > PROTOCOL_LIMITS.MAX_DEFECT_TEXT_CHARS) {
    return {
      ok: false,
      error: `Defect expected text exceeds limit of ${PROTOCOL_LIMITS.MAX_DEFECT_TEXT_CHARS} characters`,
    };
  }

  if (typeof observed !== "string" || observed.trim() === "") {
    return { ok: false, error: "Defect observed behavior must be a non-empty string" };
  }
  if (observed.length > PROTOCOL_LIMITS.MAX_DEFECT_TEXT_CHARS) {
    return {
      ok: false,
      error: `Defect observed text exceeds limit of ${PROTOCOL_LIMITS.MAX_DEFECT_TEXT_CHARS} characters`,
    };
  }

  const result: ChildDefectReport = {
    expected: expected.trim(),
    observed: observed.trim(),
  };

  if (scope !== undefined) {
    if (typeof scope !== "string" || scope.trim() === "") {
      return { ok: false, error: "Defect scope must be a non-empty string when provided" };
    }
    if (scope.length > PROTOCOL_LIMITS.MAX_SCOPE_CHARS) {
      return {
        ok: false,
        error: `Defect scope exceeds limit of ${PROTOCOL_LIMITS.MAX_SCOPE_CHARS} characters`,
      };
    }
    result.scope = scope.trim();
  }

  if (criterionId !== undefined) {
    if (typeof criterionId !== "string" || criterionId.trim() === "") {
      return { ok: false, error: "Defect criterionId must be a non-empty string when provided" };
    }
    if (criterionId.length > PROTOCOL_LIMITS.MAX_CRITERION_ID_CHARS) {
      return {
        ok: false,
        error: `Defect criterionId exceeds limit of ${PROTOCOL_LIMITS.MAX_CRITERION_ID_CHARS} characters`,
      };
    }
    result.criterionId = criterionId.trim();
  }

  if (file !== undefined) {
    if (typeof file !== "string" || file.trim() === "") {
      return { ok: false, error: "Defect file must be a non-empty string when provided" };
    }
    if (file.length > PROTOCOL_LIMITS.MAX_FILE_PATH_CHARS) {
      return {
        ok: false,
        error: `Defect file path exceeds limit of ${PROTOCOL_LIMITS.MAX_FILE_PATH_CHARS} characters`,
      };
    }
    result.file = file.trim();
  }

  if (line !== undefined) {
    if (
      typeof line !== "number" ||
      !Number.isInteger(line) ||
      line < 1 ||
      line > PROTOCOL_LIMITS.MAX_LINE_NUMBER
    ) {
      return {
        ok: false,
        error: `Defect line must be a positive integer between 1 and ${PROTOCOL_LIMITS.MAX_LINE_NUMBER}`,
      };
    }
    result.line = line;
  }

  if (severity !== undefined) {
    if (severity !== "blocker" && severity !== "major" && severity !== "nit") {
      return {
        ok: false,
        error: "Defect severity must be 'blocker', 'major', or 'nit'",
      };
    }
    result.severity = severity;
  }

  return { ok: true, value: result };
}

/**
 * Validates a child completion report against bounds and type rules.
 */
export function validateCompletionReport(raw: unknown): ValidationResult<ChildCompletionReport> {
  if (!isObject(raw)) {
    return { ok: false, error: "Completion report must be a non-null object" };
  }

  if ("from" in raw || "caller" in raw) {
    return {
      ok: false,
      error: "Completion report may not specify 'from' or 'caller'; source identity is derived from trusted session/env",
    };
  }

  const { status, filesTouched, criteriaNotes } = raw;
  const result: ChildCompletionReport = {};

  if (status !== undefined) {
    if (status !== "ok" && status !== "partial" && status !== "failed") {
      return { ok: false, error: "Report status must be 'ok', 'partial', or 'failed'" };
    }
    result.status = status;
  }

  if (filesTouched !== undefined) {
    if (!Array.isArray(filesTouched)) {
      return { ok: false, error: "Report filesTouched must be an array of strings" };
    }
    if (filesTouched.length > PROTOCOL_LIMITS.MAX_TOUCHED_FILES) {
      return {
        ok: false,
        error: `Report filesTouched exceeds limit of ${PROTOCOL_LIMITS.MAX_TOUCHED_FILES} files`,
      };
    }
    const cleanFiles: string[] = [];
    for (const f of filesTouched) {
      if (typeof f !== "string" || f.trim() === "") {
        return { ok: false, error: "Each entry in filesTouched must be a non-empty string" };
      }
      if (f.length > PROTOCOL_LIMITS.MAX_FILE_PATH_CHARS) {
        return {
          ok: false,
          error: `File path in filesTouched exceeds limit of ${PROTOCOL_LIMITS.MAX_FILE_PATH_CHARS} characters`,
        };
      }
      cleanFiles.push(f.trim());
    }
    result.filesTouched = cleanFiles;
  }

  if (criteriaNotes !== undefined) {
    if (!Array.isArray(criteriaNotes)) {
      return { ok: false, error: "Report criteriaNotes must be an array" };
    }
    if (criteriaNotes.length > PROTOCOL_LIMITS.MAX_CRITERIA_NOTES) {
      return {
        ok: false,
        error: `Report criteriaNotes exceeds limit of ${PROTOCOL_LIMITS.MAX_CRITERIA_NOTES} entries`,
      };
    }
    const cleanNotes: ChildCriteriaResult[] = [];
    for (const note of criteriaNotes) {
      if (!isObject(note)) {
        return { ok: false, error: "Each criteria note must be an object" };
      }
      if (typeof note.criterion !== "string" || note.criterion.trim() === "") {
        return { ok: false, error: "Each criteria note must have a non-empty 'criterion' string" };
      }
      if (note.criterion.length > PROTOCOL_LIMITS.MAX_FILE_PATH_CHARS) {
        return {
          ok: false,
          error: `Criteria note criterion string exceeds limit of ${PROTOCOL_LIMITS.MAX_FILE_PATH_CHARS} characters`,
        };
      }
      if (typeof note.passed !== "boolean") {
        return { ok: false, error: "Each criteria note must have a boolean 'passed' field" };
      }
      const item: ChildCriteriaResult = {
        criterion: note.criterion.trim(),
        passed: note.passed,
      };
      if (note.evidence !== undefined) {
        if (typeof note.evidence !== "string") {
          return { ok: false, error: "Criteria note evidence must be a string if provided" };
        }
        if (note.evidence.length > PROTOCOL_LIMITS.MAX_DEFECT_TEXT_CHARS) {
          return {
            ok: false,
            error: `Criteria note evidence exceeds limit of ${PROTOCOL_LIMITS.MAX_DEFECT_TEXT_CHARS} characters`,
          };
        }
        item.evidence = note.evidence.trim();
      }
      cleanNotes.push(item);
    }
    result.criteriaNotes = cleanNotes;
  }

  return { ok: true, value: result };
}

/**
 * Validates correlation fields.
 */
export function validateCorrelation(raw: unknown): ValidationResult<ChildMessageCorrelation> {
  if (!isObject(raw)) {
    return { ok: false, error: "Correlation metadata must be a non-null object" };
  }

  const { messageId, replyTo, runId, attempt } = raw;

  if (typeof messageId !== "string" || messageId.trim() === "") {
    return { ok: false, error: "Correlation messageId must be a non-empty string" };
  }
  if (messageId.length > PROTOCOL_LIMITS.MAX_ID_CHARS) {
    return {
      ok: false,
      error: `Correlation messageId exceeds limit of ${PROTOCOL_LIMITS.MAX_ID_CHARS} characters`,
    };
  }

  const result: ChildMessageCorrelation = {
    messageId: messageId.trim(),
  };

  if (replyTo !== undefined) {
    if (typeof replyTo !== "string" || replyTo.trim() === "") {
      return { ok: false, error: "Correlation replyTo must be a non-empty string when provided" };
    }
    if (replyTo.length > PROTOCOL_LIMITS.MAX_ID_CHARS) {
      return {
        ok: false,
        error: `Correlation replyTo exceeds limit of ${PROTOCOL_LIMITS.MAX_ID_CHARS} characters`,
      };
    }
    result.replyTo = replyTo.trim();
  }

  if (runId !== undefined) {
    if (typeof runId !== "string" || runId.trim() === "") {
      return { ok: false, error: "Correlation runId must be a non-empty string when provided" };
    }
    if (runId.length > PROTOCOL_LIMITS.MAX_ID_CHARS) {
      return {
        ok: false,
        error: `Correlation runId exceeds limit of ${PROTOCOL_LIMITS.MAX_ID_CHARS} characters`,
      };
    }
    result.runId = runId.trim();
  }

  if (attempt !== undefined) {
    if (
      typeof attempt !== "number" ||
      !Number.isInteger(attempt) ||
      attempt < 1 ||
      attempt > PROTOCOL_LIMITS.MAX_ATTEMPT
    ) {
      return {
        ok: false,
        error: `Correlation attempt must be a positive integer between 1 and ${PROTOCOL_LIMITS.MAX_ATTEMPT}`,
      };
    }
    result.attempt = attempt;
  }

  return { ok: true, value: result };
}

/**
 * Validates an exit sidecar payload.
 * Distinguishes legacy sidecars ({ type: "done" } / { type: "ping" }) from typed payloads.
 * Rejects invalid typed payloads rather than silently downgrading.
 */
export function validateExitSidecar(
  raw: unknown,
): { ok: true; value: ExitSidecarData; isLegacy: boolean } | { ok: false; error: string } {
  if (!isObject(raw)) {
    return { ok: false, error: "Exit sidecar must be a JSON object" };
  }

  const type = raw.type;
  if (type !== "done" && type !== "ping") {
    return { ok: false, error: `Invalid sidecar type: '${type}' (expected 'done' or 'ping')` };
  }

  if (type === "done") {
    if ("defect" in raw) {
      return { ok: false, error: "Defect payload is not allowed on a 'done' sidecar" };
    }

    let report: ChildCompletionReport | undefined;
    if (raw.report !== undefined) {
      const reportVal = validateCompletionReport(raw.report);
      if (!reportVal.ok) return { ok: false, error: reportVal.error };
      report = reportVal.value;
    }

    let correlation: ChildMessageCorrelation | undefined;
    if (raw.correlation !== undefined) {
      const corrVal = validateCorrelation(raw.correlation);
      if (!corrVal.ok) return { ok: false, error: corrVal.error };
      correlation = corrVal.value;
    }

    let runId: string | undefined;
    if (raw.runId !== undefined) {
      if (typeof raw.runId !== "string" || raw.runId.trim() === "") {
        return { ok: false, error: "runId must be a non-empty string when provided" };
      }
      runId = raw.runId.trim();
    }

    const isLegacy =
      raw.report === undefined &&
      raw.correlation === undefined &&
      raw.runId === undefined &&
      raw.schemaVersion === undefined;

    const value: ChildDonePayload = {
      type: "done",
      ...(report ? { report } : {}),
      ...(correlation ? { correlation } : {}),
      ...(runId ? { runId } : {}),
      ...(raw.schemaVersion === 1 ? { schemaVersion: 1 } : {}),
    };

    return { ok: true, value, isLegacy };
  }

  // type === "ping"
  const message = raw.message;
  if (typeof message !== "string") {
    return { ok: false, error: "Ping sidecar must contain a 'message' string" };
  }
  if (message.length > PROTOCOL_LIMITS.MAX_MESSAGE_CHARS) {
    return {
      ok: false,
      error: `Ping message exceeds limit of ${PROTOCOL_LIMITS.MAX_MESSAGE_CHARS} characters`,
    };
  }

  const name = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : "subagent";

  let defect: ChildDefectReport | undefined;
  if (raw.defect !== undefined) {
    const defectVal = validateDefectReport(raw.defect);
    if (!defectVal.ok) return { ok: false, error: defectVal.error };
    defect = defectVal.value;
  }

  let correlation: ChildMessageCorrelation | undefined;
  if (raw.correlation !== undefined) {
    const corrVal = validateCorrelation(raw.correlation);
    if (!corrVal.ok) return { ok: false, error: corrVal.error };
    correlation = corrVal.value;
  }

  let runId: string | undefined;
  if (raw.runId !== undefined) {
    if (typeof raw.runId !== "string" || raw.runId.trim() === "") {
      return { ok: false, error: "runId must be a non-empty string when provided" };
    }
    runId = raw.runId.trim();
  }

  const isLegacy =
    raw.defect === undefined &&
    raw.correlation === undefined &&
    raw.runId === undefined &&
    raw.schemaVersion === undefined;

  const value: ChildPingPayload = {
    type: "ping",
    name,
    message,
    ...(defect ? { defect } : {}),
    ...(correlation ? { correlation } : {}),
    ...(runId ? { runId } : {}),
    ...(raw.schemaVersion === 1 ? { schemaVersion: 1 } : {}),
  };

  return { ok: true, value, isLegacy };
}

/**
 * Creates a unique message correlation record.
 */
export function createChildCorrelation(opts?: {
  replyTo?: string;
  attempt?: number;
  runId?: string;
}): ChildMessageCorrelation {
  const correlation: ChildMessageCorrelation = {
    messageId: `msg-${randomUUID().slice(0, 12)}`,
  };
  if (opts?.replyTo) correlation.replyTo = opts.replyTo.trim();
  if (opts?.attempt) correlation.attempt = opts.attempt;
  if (opts?.runId) correlation.runId = opts.runId.trim();
  return correlation;
}

/**
 * Derives trusted child source identity from the environment.
 * Never inspects or trusts untrusted caller claims.
 */
export function resolveTrustedSourceIdentity(
  env: Record<string, string | undefined> = process.env,
): ChildSourceIdentity | null {
  const childId = env.PI_SUBAGENT_ID;
  const sessionFile = env.PI_SUBAGENT_SESSION;
  if (!childId || !sessionFile) return null;

  return {
    childId,
    scope: env.PI_SUBAGENT_SCOPE,
    name: env.PI_SUBAGENT_NAME || "subagent",
    sessionFile,
  };
}
