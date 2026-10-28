/**
 * Handoff receipt — proof, from the child's own transcript, that it actually read
 * the spec it was spawned against.
 *
 * The ticket tells a child to call `artifact_recall({ id })`. That instruction was
 * never verifiable: a worker could implement from the assignment paragraph alone,
 * or from a guess, and the orchestrator had no way to tell. The review then judged
 * a diff against criteria the worker never saw. Reading the spec is the one step
 * that cannot be inferred from a diff, so it is checked as a fact about the
 * transcript rather than trusted as a promise in the prompt.
 */
import { readFileSync } from "node:fs";

export interface HandoffReceipt {
  /** A successful recall of this handoff was recorded. */
  read: boolean;
  /**
   * Artifact version that was actually read, when the recall result reported one.
   * `null` when the read could not be attributed to a version.
   */
  version: number | null;
  /** Number of recall calls made for this artifact (a failed attempt still counts). */
  calls: number;
  /** ISO timestamp of the entry that made the first successful call. */
  firstReadAt?: string;
  /**
   * Whether a transcript existed to inspect at all. A missing transcript is not
   * the same claim as "did not read": it is unverifiable, and callers treat the
   * two differently.
   */
  inspected: boolean;
}

export const UNREAD_RECEIPT: HandoffReceipt = { read: false, version: null, calls: 0, inspected: false };

function textOfResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
    .join("\n");
}

/**
 * Parse a session transcript (JSONL) for a successful recall of `artifactId`.
 *
 * Tolerant of the two shapes this repo produces: the harness's flat
 * `{type:"toolCall"}` / `{type:"toolResult"}` parts and Pi's
 * `{message:{role:"assistant"|"toolResult", ...}}` entries. Both are matched by
 * `toolCallId`, so a recall of a *different* artifact cannot satisfy the receipt,
 * and a result whose text belongs to another artifact is ignored even if it is the
 * only recall in the file.
 */
export function parseHandoffReceipt(transcript: string, artifactId: string): HandoffReceipt {
  const wanted = artifactId.trim().toLowerCase();
  const receipt: HandoffReceipt = { read: false, version: null, calls: 0, inspected: true };
  if (!wanted) return receipt;

  const calls = new Map<string, string | undefined>();

  for (const line of transcript.split("\n")) {
    if (!line.includes("artifact_recall")) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry?.message ?? entry;
    const content = message?.content;

    // ── the call ──────────────────────────────────────────────────────────
    // Two shapes: flat `{type:"toolCall"}` parts (this repo's harness/mock
    // transcripts) and Pi's assistant message with an array of toolCall parts.
    const callParts: any[] = [];
    if (entry?.type === "toolCall") callParts.push(entry);
    if (Array.isArray(content)) callParts.push(...content.filter((part: any) => part?.type === "toolCall"));
    for (const part of callParts) {
      if (part.name !== "artifact_recall") continue;
      const args = part.arguments ?? part.input ?? {};
      const id = typeof args.id === "string" ? args.id.trim().toLowerCase() : "";
      if (id !== wanted) continue;
      receipt.calls += 1;
      if (typeof part.id === "string") calls.set(part.id, entry?.timestamp);
    }

    // ── the result ────────────────────────────────────────────────────────
    // A result is either a flat `{type:"toolResult"}` entry or a Pi message with
    // role "toolResult". Both are matched to the call by id, so a result for a
    // different artifact cannot be miscounted as a read of this one.
    const flatResult = entry?.type === "toolResult" ? entry : undefined;
    const messageResult = message?.role === "toolResult" ? message : undefined;
    const result = flatResult ?? messageResult;
    if (result && result.toolName === "artifact_recall" && result.isError !== true) {
      const callId = typeof result.toolCallId === "string" ? result.toolCallId : "";
      if (!callId || !calls.has(callId)) continue;
      const text = textOfResult(result.content);
      // The recall header is the one line that proves this text is the artifact
      // itself, not an error or a mention of its id in prose.
      if (!text.includes(`=== Artifact: [${artifactId}]`)) continue;
      receipt.read = true;
      receipt.firstReadAt ??= calls.get(callId);
      const version = text.match(/\(v(\d+),/);
      if (version) receipt.version = Number(version[1]);
    }
  }

  return receipt;
}

/**
 * Read a child's transcript from disk and compute its receipt.
 *
 * A missing file is `inspected: false`, never "read". A caller that cannot tell
 * the two apart would let a deleted transcript pass as compliance.
 */
export function handoffReceiptFromFile(sessionFile: string | undefined, artifactId: string | undefined): HandoffReceipt {
  if (!sessionFile || !artifactId) return UNREAD_RECEIPT;
  let transcript: string;
  try {
    transcript = readFileSync(sessionFile, "utf8");
  } catch {
    return UNREAD_RECEIPT;
  }
  return parseHandoffReceipt(transcript, artifactId);
}

/** The refusal text shared by `agent_check` and `agent_review`. */
export function handoffReceiptProblem(input: {
  scope: string;
  artifactId: string;
  receipt: HandoffReceipt;
  action: "check" | "approve";
}): string | undefined {
  if (input.receipt.read) return undefined;
  const verdict = input.action === "check" ? "checked" : "approved";
  if (!input.receipt.inspected) {
    return `Refusing to ${input.action === "check" ? "check" : "approve"} "${input.scope}": its child's transcript is not on disk, `
      + `so there is no evidence it read the handoff (${input.artifactId}). A result cannot be ${verdict} against a spec `
      + `nobody can prove was read. Restore the transcript, or resume the child with agent_steer and re-run.`;
  }
  return `Refusing to ${input.action === "check" ? "check" : "approve"} "${input.scope}": its child never recalled the handoff `
    + `spec (${input.artifactId}), so the work was done against something other than the spec the review judges. `
    + `Resume the child and require artifact_recall({ id: "${input.artifactId}" }) before it reports again, `
    + `then re-run. This is not a warning: the gate is closed until the read is in the transcript.`;
}
