import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export type JsonObject = Record<string, unknown>;
export type ProviderConfig = JsonObject & { models?: JsonObject[] };
export type ModelsConfig = JsonObject & { providers: Record<string, ProviderConfig> };
export type ConfigSnapshot = { path: string; source: string | undefined; config: ModelsConfig };

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateConfig(value: unknown): asserts value is ModelsConfig {
  if (!object(value) || !object(value.providers)) throw new Error("models.json must contain a providers object.");
  for (const provider of Object.values(value.providers)) {
    if (!object(provider) || (provider.models !== undefined && (!Array.isArray(provider.models) ||
      provider.models.some(model => !object(model) || typeof model.id !== "string" || !model.id.trim())))) {
      throw new Error("models.json contains an invalid provider or model. Fix it before using /provider.");
    }
  }
}

export async function readConfig(path: string): Promise<ConfigSnapshot> {
  let source: string | undefined;
  try {
    // Atomic replacement must not silently replace a symlink or special file.
    if (!(await lstat(path)).isFile()) throw new Error("models.json must be a regular file, not a symlink.");
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let config: unknown;
  try { config = source === undefined ? { providers: {} } : JSON.parse(source.replace(/^\uFEFF/, "")); }
  catch { throw new Error("models.json is not strict JSON. Invalid JSON or JSON-with-comments must be edited manually; nothing was changed."); }
  validateConfig(config);
  return { path, source, config };
}

/** Cooperates with Pi's mutation queue and other wizard saves; detects stale dialogs. */
export function saveConfig(snapshot: ConfigSnapshot, config: ModelsConfig): Promise<void> {
  return withFileMutationQueue(snapshot.path, () => saveLocked(snapshot, config));
}

async function saveLocked(snapshot: ConfigSnapshot, config: ModelsConfig): Promise<void> {
  validateConfig(config);
  const path = snapshot.path;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.workflow.lock`;
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Another /provider save holds models.json.workflow.lock. Retry after it finishes; remove a stale lock only when no save is running.");
    }
    throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const current = await readConfig(path);
    if (current.source !== snapshot.source) throw new Error("models.json changed while the dialog was open. Run /provider again; nothing was overwritten.");
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
      await file.sync();
    } finally { await file.close(); }
    // Recheck after writing/syncing the temp file, not only before that blocking I/O.
    // External editors do not honor our lock: this detects conflicts, not an OS-wide CAS.
    if ((await readConfig(path)).source !== snapshot.source) {
      throw new Error("models.json changed during save. Run /provider again; nothing was overwritten.");
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}

export function providerId(value: string): string {
  const id = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id) || ["__proto__", "prototype", "constructor"].includes(id)) {
    throw new Error("Use a provider ID starting with a lowercase letter or digit, followed by lowercase letters, digits, dots, underscores or hyphens.");
  }
  return id;
}

export function endpoint(value: string): string {
  const text = value.trim();
  let url: URL;
  try { url = new URL(text); } catch { throw new Error("Enter a complete http:// or https:// endpoint URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP(S) endpoint without embedded credentials, query parameters or fragments.");
  }
  return text.replace(/\/+$/, "");
}

export function positiveInteger(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new Error("Enter a positive whole-number token limit.");
  }
  return Number(value);
}

export function environmentKey(value: string): string {
  const name = value.trim().replace(/^\$\{([^}]+)\}$/, "$1").replace(/^\$/, "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Enter an environment variable name, not an API key or command.");
  return `$${name}`;
}

export function putModel(provider: ProviderConfig, model: JsonObject): ProviderConfig {
  const models = [...(provider.models ?? [])];
  const index = models.findIndex(entry => entry.id === model.id);
  if (index < 0) models.push(model);
  else models[index] = { ...models[index], ...model };
  const overrides = provider.modelOverrides;
  const existingOverride = object(overrides) ? overrides[String(model.id)] : undefined;
  if (object(overrides) && object(existingOverride)) {
    const override = { ...existingOverride };
    // Native modelOverrides win over models: synchronize only fields the form edits.
    for (const key of ["name", "reasoning", "input", "contextWindow", "maxTokens"]) {
      if (Object.hasOwn(model, key)) override[key] = model[key];
    }
    return { ...provider, models, modelOverrides: { ...overrides, [String(model.id)]: override } };
  }
  return { ...provider, models };
}

export function parseProviderSlot(id: string): { base: string; index: number } | undefined {
  const match = /^(.+)-([1-9][0-9]*)$/.exec(id.trim());
  if (!match) return undefined;
  return { base: match[1]!, index: Number(match[2]!) };
}

export function findProviderAccounts(
  providers: Record<string, ProviderConfig>,
  baseId: string,
): Array<{ id: string; index: number; provider: ProviderConfig }> {
  const result: Array<{ id: string; index: number; provider: ProviderConfig }> = [];
  const base = baseId.trim();
  for (const [id, provider] of Object.entries(providers)) {
    if (id === base) {
      result.push({ id, index: 1, provider });
    } else {
      const slot = parseProviderSlot(id);
      if (slot && slot.base === base) {
        result.push({ id, index: slot.index, provider });
      }
    }
  }
  return result.sort((a, b) => a.index - b.index);
}

export function nextProviderSlot(providers: Record<string, ProviderConfig>, baseId: string): number {
  const accounts = findProviderAccounts(providers, baseId);
  if (!accounts.length) return 1;
  const max = Math.max(...accounts.map(a => a.index));
  return max + 1;
}

export function listProviderFamilies(
  providers: Record<string, ProviderConfig>,
): Map<string, Array<{ id: string; index: number; provider: ProviderConfig }>> {
  const families = new Map<string, Array<{ id: string; index: number; provider: ProviderConfig }>>();
  for (const [id, provider] of Object.entries(providers)) {
    const slot = parseProviderSlot(id);
    const base = slot ? slot.base : id;
    const index = slot ? slot.index : 1;
    const list = families.get(base) ?? [];
    list.push({ id, index, provider });
    families.set(base, list);
  }
  for (const list of families.values()) {
    list.sort((a, b) => a.index - b.index);
  }
  return families;
}

