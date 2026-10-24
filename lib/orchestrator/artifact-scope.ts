/**
 * artifact-scope.ts — compatibility layer over `handoff.ts`.
 *
 * This file used to own a second spec renderer with a different heading set, so
 * the file the orchestrator audited and the ticket the child received could drift
 * apart while both looked correct. There is now exactly one renderer
 * (`handoff.ts`), and everything here delegates to it.
 *
 * The functions are kept because they have callers and a settled path convention;
 * they are not a second source of truth about what a spec says.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  HandoffError,
  handoffIdFor,
  renderHandoffForChild,
  sanitizeScope,
  validateHandoff,
  type HandoffRecord,
} from "./handoff.ts";

export { HandoffError, sanitizeScope, handoffIdFor };

/** Directory holding one run's audit copies. Orchestrator-side only. */
export function getSpecDeliveryDir(artifactsBaseDir: string, parentSessionId: string, runId: string): string {
  return join(artifactsBaseDir, parentSessionId, runId);
}

export function getSpecFilePath(
  artifactsBaseDir: string,
  parentSessionId: string,
  runId: string,
  scope: string,
): string {
  // Scope-based name, not `handoffIdFor(scope)`: the enclosing run directory
  // already disambiguates attempts, and a human auditing the tree should be able
  // to recognise the file. The scope IS the unique key here, so a hash adds
  // nothing but unreachability.
  return join(getSpecDeliveryDir(artifactsBaseDir, parentSessionId, runId), `${sanitizeScope(scope)}.spec.md`);
}

export interface WorkSpecOptions {
  scope: string;
  title?: string;
  goal?: string;
  acceptanceCriteria: string[];
  laneFiles: string[];
  outOfLaneFiles?: string[];
  reportShape?: string;
  guidance?: string;
  interfaces?: string[];
  vision?: string;
}

/** The one renderer. Kept as a named export for callers that render in memory. */
export function createWorkSpecContent(options: WorkSpecOptions): string {
  return renderHandoffForChild(toRecord(options));
}

function toRecord(options: WorkSpecOptions): HandoffRecord {
  const validated = validateHandoff({
    scope: options.scope,
    goal: options.goal ?? options.title ?? `Complete the ${options.scope} work unit.`,
    acceptanceCriteria: options.acceptanceCriteria,
    laneFiles: options.laneFiles,
    outOfLaneFiles: options.outOfLaneFiles,
    reportShape: options.reportShape,
    guidance: options.guidance,
    interfaces: options.interfaces,
    vision: options.vision,
  });
  return { ...validated, parentSessionId: "" };
}

export function writeWorkSpec(
  artifactsBaseDir: string,
  parentSessionId: string,
  runId: string,
  options: WorkSpecOptions,
): string {
  const content = createWorkSpecContent(options);
  const specPath = getSpecFilePath(artifactsBaseDir, parentSessionId, runId, options.scope);
  const dir = getSpecDeliveryDir(artifactsBaseDir, parentSessionId, runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(specPath, content, { mode: 0o600 });
  return specPath;
}

/**
 * Read the lane list back out of a rendered spec.
 *
 * Parsed from the canonical heading only, so a stray bullet elsewhere in the
 * document cannot be mistaken for a lane file.
 */
export function parseSpecLaneFiles(specContent: string): string[] {
  const files: string[] = [];
  let inLaneSection = false;

  for (const line of String(specContent ?? "").split("\n")) {
    if (/^##\s+Files you own/i.test(line) || /^##\s+Files in lane/i.test(line)) {
      inLaneSection = true;
      continue;
    }
    if (inLaneSection && /^##\s/.test(line)) break;
    if (!inLaneSection) continue;
    const match = line.match(/^[-*]\s*`([^`\r\n]+)`/);
    if (match) {
      const item = match[1].trim();
      if (item && !item.startsWith("(")) files.push(item);
    }
  }

  return files;
}

/** Stable run id for a handoff attempt. Recorded so two respawns are distinguishable. */
export function runIdFor(scope: string, salt = ""): string {
  return createHash("sha256").update(`${sanitizeScope(scope)}:${salt}`).digest("hex").slice(0, 10);
}
