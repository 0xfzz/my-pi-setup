/**
 * The durable side of plugin storage.
 *
 * `PluginStorage` deliberately never touches the disk; the host decides when a
 * snapshot is written. This module is that decision: one atomic file beside the
 * operator state, read once at boot and written back (debounced) after every
 * mutation. Without it a plugin's data lived only as long as the process.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { STORAGE_SCOPES, type StorageSnapshot } from "./storage.ts";

const SNAPSHOT_VERSION = 1;

export type StorageLoadResult = { snapshot?: StorageSnapshot; warning?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate untrusted JSON into a snapshot. Anything unusable is a warning, not a crash. */
function parseSnapshot(input: unknown): StorageLoadResult {
  if (!isRecord(input)) return { warning: "storage snapshot must be a JSON object" };
  if (input.version !== SNAPSHOT_VERSION) return { warning: `unsupported storage snapshot version ${String(input.version)}` };
  if (!isRecord(input.entries)) return { warning: "storage snapshot entries must be an object" };

  const entries: StorageSnapshot["entries"] = {};
  for (const [pluginId, scopes] of Object.entries(input.entries)) {
    if (!isRecord(scopes)) return { warning: `storage snapshot for "${pluginId}" must be an object` };
    entries[pluginId] = {};
    for (const [scope, values] of Object.entries(scopes)) {
      if (!(STORAGE_SCOPES as readonly string[]).includes(scope)) {
        return { warning: `storage snapshot for "${pluginId}" has unknown scope "${scope}"` };
      }
      if (!isRecord(values) || !Object.values(values).every((value) => typeof value === "string")) {
        return { warning: `storage snapshot for "${pluginId}/${scope}" must map keys to strings` };
      }
      entries[pluginId][scope] = Object.fromEntries(Object.entries(values) as Array<[string, string]>);
    }
  }
  return { snapshot: { version: SNAPSHOT_VERSION, entries } };
}

/** The persisted snapshot, or a warning explaining why it was not usable. */
export function loadStorageSnapshot(path: string): StorageLoadResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    return { warning: `could not read ${path}: ${String(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { warning: `${path} is not valid JSON; plugin storage starts empty (${String(error)})` };
  }
  const result = parseSnapshot(parsed);
  return result.warning === undefined ? result : { warning: `${path} rejected; plugin storage starts empty (${result.warning})` };
}

/** Atomic write: a temp file in the same directory, then a rename. */
export function saveStorageSnapshot(path: string, snapshot: StorageSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`);
  renameSync(tmp, path);
}
