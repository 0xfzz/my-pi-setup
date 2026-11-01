/**
 * Compaction telemetry.
 *
 * The point of this file is calibration: budgets are guesses until someone
 * compares estimates against provider usage and task outcomes. Records are
 * deliberately metadata-only — no prompt text, tool output, file contents, or
 * credentials — so the log is safe to keep and share.
 */

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

export const TELEMETRY_VERSION = 1;
const MAX_BYTES = 2 * 1024 * 1024;

export interface CompactionTelemetryRecord {
  ts: string;
  version: number;
  mode: "budgeted" | "legacy";
  outcome: "committed" | "shadow" | "skipped";
  reason?: string;
  provider?: string;
  model?: string;
  contextWindow: number;
  calibrated: boolean;
  profileKey?: string;
  usageTokens?: number | null;
  triggerTokens: number;
  inputAllowance: number;
  qualityTarget: number;
  postCompactionTarget: number;
  summaryBudget: number;
  tailBudget?: number;
  tailTokens?: number;
  prefixTokens?: number;
  newTokens?: number;
  summaryTokens?: number;
  evidenceTokens?: number;
  evidenceItems?: number;
  fixedOverheadTokens?: number;
  afterTokens?: number;
  headroomSatisfied?: boolean;
  exception?: string;
  durationMs?: number;
}

/** Append one record. Never throws: telemetry must not break compaction. */
export async function appendTelemetry(
  filePath: string,
  record: CompactionTelemetryRecord,
): Promise<boolean> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await rotateIfLarge(filePath);
    await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function rotateIfLarge(filePath: string): Promise<void> {
  try {
    const info = await stat(filePath);
    if (info.size < MAX_BYTES) return;
    await rename(filePath, `${filePath}.1`);
  } catch {
    // Missing file or rename race: appending is still correct.
  }
}
