/**
 * The persisted on/off choice for automatic titles.
 *
 * pi exposes settings to extensions read-only, so the choice lives in its own
 * small file under the agent directory. Parsing is pure; the reads and writes
 * are the only I/O and are kept to these two functions.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const AUTO_TITLE_STATE_FILE = "auto-title.json";

/** The stored choice, or undefined when the file is missing or not a valid choice. */
export function parseAutoTitleFlag(text: string): boolean | undefined {
  try {
    const data = JSON.parse(text) as { enabled?: unknown };
    return typeof data.enabled === "boolean" ? data.enabled : undefined;
  } catch {
    return undefined;
  }
}

export function readAutoTitleFlag(file: string): boolean | undefined {
  try {
    return parseAutoTitleFlag(readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

export function writeAutoTitleFlag(file: string, enabled: boolean): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ v: 1, enabled }, null, 2)}\n`);
}
