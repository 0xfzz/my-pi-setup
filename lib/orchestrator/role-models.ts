/**
 * role-models.ts — which model a delegated child runs on.
 *
 * The orchestrator has three kinds of children and they want different models:
 * a devil's advocate should be a strong critic, workers are the bulk of spend,
 * and a QA reviewer decides pass/fail. This module maps a role to one model, or
 * to a pool that is rolled once per spawned child, so a pooled panel is diverse
 * by construction.
 *
 * Provider awareness is the point: a binding is `{ provider, model }`, not a
 * bare id. Model ids can contain slashes (`openrouter/meta-llama/llama-3`), so a
 * `"provider/model"` string is ambiguous when split; structured storage keeps
 * the two halves separate and `modelKey` renders them for display and for pi's
 * `--model` argument.
 *
 * Pure: no I/O, no pi imports, no vendor imports. The registry is a narrow port
 * so this is testable without a running host, and the RNG is injected so a pool
 * roll is deterministic in tests.
 */

export const ORCH_ROLES = ["devil-advocate", "worker", "qa-review"] as const;
export type OrchRole = (typeof ORCH_ROLES)[number];

/** Upper bound on a pool: more members add variance, not coverage. */
export const MAX_POOL = 8;

export interface ModelRef {
  provider: string;
  model: string;
}

/** `inherit` follows the parent (no `--model` argument is passed). */
export type RoleBinding = "inherit" | ModelRef | ModelRef[];
export type RoleModels = Partial<Record<OrchRole, RoleBinding>>;

/** The slice of the host model registry this module needs. */
export interface ModelRegistryPort {
  has(provider: string, model: string): boolean;
  hasAuth(provider: string, model: string): boolean;
}

export interface ResolvedRoleModel {
  /** `undefined` means "let pi inherit the parent's model". */
  model?: string;
  source: "explicit" | "role" | "agent" | "global" | "default";
  role: OrchRole;
  /** How many pool members the roll chose from (1 for a single binding). */
  poolSize?: number;
  /** Facts the caller should surface: fallback, missing credentials. */
  notes: string[];
}

export function isOrchRole(value: unknown): value is OrchRole {
  return typeof value === "string" && (ORCH_ROLES as readonly string[]).includes(value);
}

export function modelKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

function isModelRef(value: unknown): value is ModelRef {
  const ref = value as Partial<ModelRef> | null;
  return Boolean(ref) && typeof ref?.provider === "string" && ref.provider.trim() !== ""
    && typeof ref?.model === "string" && ref.model.trim() !== "";
}

export function normalizeModelRef(value: unknown): ModelRef | undefined {
  if (isModelRef(value)) return { provider: value.provider.trim(), model: value.model.trim() };
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text === "inherit") return undefined;
    const slash = text.indexOf("/");
    if (slash <= 0 || slash === text.length - 1) return undefined;
    return { provider: text.slice(0, slash).trim(), model: text.slice(slash + 1).trim() };
  }
  return undefined;
}

/**
 * Parse a stored binding. Fails closed with reasons rather than guessing: a
 * malformed entry must not silently become "inherit", because that hides a
 * configuration mistake behind working-looking behaviour.
 */
export function parseBinding(value: unknown): { ok: true; binding: RoleBinding } | { ok: false; problems: string[] } {
  if (value === "inherit") return { ok: true, binding: "inherit" };

  const single = isModelRef(value) ? normalizeModelRef(value) : undefined;
  if (single) return { ok: true, binding: single };

  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined;
  if (!items) return { ok: false, problems: ["a binding is \"inherit\", { provider, model }, or a list of those"] };

  const problems: string[] = [];
  const refs: ModelRef[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const ref = normalizeModelRef(item);
    if (!ref) {
      problems.push(`"${String(item).trim()}" is not a model; name it provider/model (bare ids can be ambiguous across providers)`);
      continue;
    }
    const key = modelKey(ref);
    if (seen.has(key)) {
      problems.push(`${key} is listed twice`);
      continue;
    }
    seen.add(key);
    refs.push(ref);
  }
  if (!refs.length && !problems.length) problems.push("the pool is empty");
  if (refs.length > MAX_POOL) problems.push(`a pool holds at most ${MAX_POOL} models (got ${refs.length})`);
  if (problems.length) return { ok: false, problems };
  return { ok: true, binding: refs.length === 1 ? refs[0]! : refs };
}

/** Tolerant read of persisted settings: keep valid roles, drop the rest. */
export function normalizeRoleModels(raw: unknown): RoleModels {
  const out: RoleModels = {};
  if (!raw || typeof raw !== "object") return out;
  for (const role of ORCH_ROLES) {
    const parsed = parseBinding((raw as Record<string, unknown>)[role]);
    if (parsed.ok) out[role] = parsed.binding;
  }
  return out;
}

/** One-line rendering for the role menu. */
export function renderBinding(binding: RoleBinding | undefined): string {
  if (!binding) return "inherit";
  if (binding === "inherit") return "inherit";
  if (Array.isArray(binding)) return `[${binding.map(modelKey).join(", ")}]`;
  return modelKey(binding);
}

/** `worker  [a, b]`, one row per role, in lifecycle order. */
export function renderRoleMenu(roleModels: RoleModels): string[] {
  return ORCH_ROLES.map((role) => `${role}  ${renderBinding(roleModels[role])}`);
}

/**
 * Resolve the model argument for one spawned child.
 *
 * Precedence: explicit tool argument, then the role binding, then the agent
 * profile, then the global default, then pi's own behaviour. A binding that no
 * longer resolves falls back rather than failing the spawn: a removed provider
 * must not strand the orchestrator.
 */
export function resolveRoleModel(input: {
  role: OrchRole;
  binding?: RoleBinding;
  /** Raw `model` argument from the tool call, when present. */
  explicit?: string;
  registry: ModelRegistryPort;
  rng?: () => number;
  agentDefault?: string;
  globalDefault?: string;
}): ResolvedRoleModel {
  const { role, binding, registry } = input;
  const notes: string[] = [];
  const rng = input.rng ?? Math.random;

  const explicit = String(input.explicit ?? "").trim();
  if (explicit) {
    if (explicit === "inherit") {
      return { role, model: undefined, source: "explicit", notes: ["inherit (explicit)"] };
    }
    const ref = normalizeModelRef(explicit);
    const key = ref ? modelKey(ref) : explicit;
    if (ref && !registry.has(ref.provider, ref.model)) {
      notes.push(`${key} is not in the current registry`);
    }
    return { role, model: key, source: "explicit", notes };
  }

  if (binding === "inherit") {
    return { role, model: undefined, source: "role", notes };
  }

  if (binding) {
    const pool = Array.isArray(binding) ? binding : [binding];
    const usable = pool.filter((ref) => registry.has(ref.provider, ref.model));
    const missing = pool.filter((ref) => !usable.includes(ref)).map(modelKey);
    if (missing.length) notes.push(`${missing.join(", ")} no longer resolves`);
    if (usable.length) {
      const index = Math.min(usable.length - 1, Math.floor(rng() * usable.length));
      const chosen = usable[index]!;
      if (!registry.hasAuth(chosen.provider, chosen.model)) {
        notes.push(`no credentials for ${modelKey(chosen)} — the child may fail to start`);
      }
      return { role, model: modelKey(chosen), source: "role", poolSize: usable.length, notes };
    }
    notes.push("the role binding did not resolve; following the parent model");
    return { role, model: undefined, source: "role", poolSize: pool.length, notes };
  }

  for (const [source, value] of [["agent", input.agentDefault], ["global", input.globalDefault]] as const) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    if (text === "inherit") return { role, model: undefined, source, notes };
    const ref = normalizeModelRef(text);
    return { role, model: ref ? modelKey(ref) : text, source, notes };
  }

  return { role, model: undefined, source: "default", notes };
}

/** The attribution line a spawn/review result shows. */
export function renderAttribution(resolved: ResolvedRoleModel): string {
  const model = resolved.model ?? "inherit (parent)";
  const why = resolved.source === "explicit"
    ? "explicit override"
    : resolved.source === "role"
      ? resolved.poolSize && resolved.poolSize > 1
        ? `rolled from a ${resolved.poolSize}-model ${resolved.role} pool`
        : `${resolved.role} binding`
      : `${resolved.source} default`;
  const notes = resolved.notes.length ? ` — ${resolved.notes.join("; ")}` : "";
  return `${model} — ${why}${notes}`;
}

/**
 * Parse the text form of `/agent-model <role> <value>`.
 *
 * `known` is the registry's provider/model keys. A bare id is accepted only when
 * exactly one provider exposes it; otherwise the command reports the candidates
 * instead of guessing which provider the user meant.
 */
export function parseCommandValue(
  raw: string,
  known: readonly string[] = [],
): { ok: true; binding: RoleBinding } | { ok: false; problems: string[] } {
  const tokens = String(raw ?? "").split(",").map((token) => token.trim()).filter(Boolean);
  if (!tokens.length) return { ok: false, problems: ["give a model: inherit, provider/model, or a comma-separated pool"] };
  if (tokens.length === 1 && tokens[0] === "inherit") return { ok: true, binding: "inherit" };

  const problems: string[] = [];
  const resolved: string[] = [];
  for (const token of tokens) {
    if (token === "inherit") {
      problems.push("\"inherit\" cannot be mixed with models; use inherit alone");
      continue;
    }
    if (token.includes("/")) {
      resolved.push(token);
      continue;
    }
    const matches = known.filter((key) => key.endsWith(`/${token}`));
    if (matches.length === 1) resolved.push(matches[0]!);
    else if (matches.length === 0) problems.push(`"${token}" is not a model in the current registry; name it provider/model`);
    else problems.push(`"${token}" is ambiguous across providers (${matches.join(", ")}); name it provider/model`);
  }
  if (problems.length) return { ok: false, problems };
  return parseBinding(resolved);
}
