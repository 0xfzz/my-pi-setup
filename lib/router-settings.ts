/**
 * The rows the `/router` editor shows and the edits it can make.
 *
 * Pure, so the editor, the `/router` status report and the runtime describe the
 * same route table: a settings screen holding its own copy of the routes would
 * be a third source of truth, which is the confusion the editor exists to
 * remove.
 *
 * A row carries the facts an edit needs — which file the route lives in, what
 * its chain looks like, what is wrong with it — so the popup never re-derives
 * policy while rendering.
 */
import type { ModelChoice } from "./provider-model-picker.ts";
import {
  describeRoutePolicy, routeMethod, routeWhen,
  type RouteConfig, type RouteFailureClass, type RouteMethod, type RouteTarget, type RouteWhen,
} from "./model-routes.ts";
import type { RouteSource, SourcedRoute } from "./router-config.ts";

/** The two files a route can be saved to; a row is rewritten where it came from. */
export type RouterFileChoice = "project" | "global";

export type RouterRow = {
  route: RouteConfig;
  /** File the effective copy lives in. */
  source: RouteSource;
  /** `router/auto`: what `/model` lists. */
  id: string;
  /** `cheapest · on quota`. */
  policy: string;
  /** `antigravity/gemini-3-pro → openai/gpt-6` with pool/thinking suffixes. */
  chain: string;
  /** Problems that make the route unusable or surprising. */
  issues: readonly string[];
};

export type RouterSettingsView = {
  cwd: string;
  /** Provider that hosts the virtual models, normally `router`. */
  provider: string;
  /** Config files that contributed, in precedence order. */
  sources: readonly string[];
  rows: readonly RouterRow[];
  /** Global routes a project route currently hides. */
  shadowed: readonly RouterRow[];
  /** Pool names, so a target can be pointed at one. */
  pools: readonly string[];
  errors: readonly string[];
};

/**
 * A route the editor wants models for.
 *
 * The target list may be empty: a new route is only written once the picker
 * returned at least one model, so a cancelled picker leaves no half-made route
 * in the config.
 */
export type RouterDraft = {
  route: RouteConfig;
  file: RouterFileChoice;
};

export type RouterAction =
  | { kind: "save"; route: RouteConfig; file: RouterFileChoice }
  | { kind: "rename"; from: string; route: RouteConfig; file: RouterFileChoice }
  | { kind: "delete"; name: string; file: RouterFileChoice };

/** How the popup ended, when it did not simply close. */
export type RouterPopupResult = { kind: "pick-models"; draft: RouterDraft } | undefined;

/** Thinking levels offered per target; `undefined` leaves the request default. */
export const TARGET_THINKING = [undefined, "off", "low", "medium", "high"] as const;

/** `provider/model` plus the suffixes that change what is dispatched. */
export function describeTarget(target: RouteTarget): string {
  const pool = target.pool ? ` [${target.pool}]` : "";
  const thinking = target.thinking ? `:${target.thinking}` : "";
  return `${target.model}${pool}${thinking}`;
}

/** The chain as one line, the way `/router status` prints it. */
export function describeChain(route: RouteConfig): string {
  return route.targets.map(describeTarget).join(" → ");
}

/**
 * Problems a route row should show.
 *
 * These are warnings, not load errors: a route naming a pool that no longer
 * exists still loads, and the request fails with the pool's own message. The
 * editor says so up front instead of hiding it until a request.
 */
export function routeIssues(route: RouteConfig, pools: readonly string[]): string[] {
  const issues: string[] = [];
  const known = new Set(pools);
  const poolName = route.pool;
  if (poolName && !known.has(poolName)) issues.push(`route pool "${poolName}" is not configured`);
  for (const target of route.targets) {
    if (target.pool && !known.has(target.pool)) {
      issues.push(`target ${target.model} names unknown pool "${target.pool}"`);
    }
  }
  const seen = new Set<string>();
  for (const target of route.targets) {
    if (seen.has(target.model)) issues.push(`${target.model} is listed twice`);
    seen.add(target.model);
  }
  return issues;
}

/** One row per effective route, in config order. */
export function routerRows(sourced: readonly SourcedRoute[], provider: string, pools: readonly string[]): RouterRow[] {
  return sourced.map(({ route, source }) => ({
    route,
    source,
    id: `${provider}/${route.name}`,
    policy: describeRoutePolicy(route),
    chain: describeChain(route),
    issues: routeIssues(route, pools),
  }));
}

/** Read a row's config file back to the choice the writer understands. */
export function fileChoiceOf(source: RouteSource): RouterFileChoice {
  return source === "global" ? "global" : "project";
}

// ── Editing helpers (pure: the popup applies, then re-reads the view) ────────

/**
 * Add picked models to a chain, keeping the order the user already had.
 *
 * A model already in the chain keeps its pool and thinking level: re-adding it
 * from the picker is a no-op rather than a silent reset of its settings.
 */
export function mergeTargets(existing: readonly RouteTarget[], picked: readonly string[]): RouteTarget[] {
  const byModel = new Map(existing.map((target) => [target.model, target]));
  const merged = existing.map((target) => ({ ...target }));
  for (const model of picked) {
    if (byModel.has(model)) continue;
    byModel.set(model, { model });
    merged.push({ model });
  }
  return merged;
}

/** Move one target by `delta`, clamping instead of wrapping. */
export function moveTarget(targets: readonly RouteTarget[], index: number, delta: number): RouteTarget[] {
  const next = targets.map((target) => ({ ...target }));
  const to = index + delta;
  if (index < 0 || index >= next.length || to < 0 || to >= next.length) return next;
  const [moved] = next.splice(index, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** Replace one target in place; `undefined` removes it. */
export function replaceTarget(
  targets: readonly RouteTarget[],
  index: number,
  replacement: RouteTarget | undefined,
): RouteTarget[] {
  if (index < 0 || index >= targets.length) return targets.map((target) => ({ ...target }));
  return targets
    .map((target, position) => (position === index ? replacement : target))
    .filter((target): target is RouteTarget => target !== undefined)
    .map((target) => ({ ...target }));
}

/** Next value in a cycle, so one key can walk the whole vocabulary. */
export function cycleValue<T>(values: readonly T[], current: T): T {
  const index = values.indexOf(current);
  return values[(index + 1) % values.length]!;
}

export function cycleMethod(current: RouteMethod): RouteMethod {
  return cycleValue<RouteMethod>(["priority", "round-robin", "cheapest", "last-good"], current);
}

export function cycleWhen(current: RouteWhen): RouteWhen {
  return cycleValue<RouteWhen>(["turn", "failure", "quota", "overflow"], current);
}

/** The route as saved: defaults dropped so a config stays small and readable. */
export function withPolicy(route: RouteConfig, method: RouteMethod, when: RouteWhen): RouteConfig {
  return {
    ...route,
    ...(method === "priority" ? { method: undefined } : { method }),
    ...(when === "turn" ? { when: undefined } : { when }),
  };
}

export function methodOf(route: RouteConfig): RouteMethod {
  return routeMethod(route);
}

export function whenOf(route: RouteConfig): RouteWhen {
  return routeWhen(route);
}

// ── Validation for the name field ────────────────────────────────────────────

const ROUTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validate a new route name, returning the reason it is unusable.
 *
 * The same rule the parser applies, checked at the field so a typo is corrected
 * before the dialog moves on rather than after a save is refused.
 */
export function routeNameProblem(name: string, existing: readonly string[]): string | undefined {
  const value = name.trim();
  if (!value) return "A route needs a name.";
  if (!ROUTE_NAME.test(value)) return "Use letters, digits, dot, dash or underscore; start with a letter or digit.";
  if (existing.includes(value)) return `"${value}" already exists.`;
  if (value === "status" || value === "help") return `"${value}" reads like a /router subcommand; pick another name.`;
  return undefined;
}

/** `route-2`, `route-3`, …: a name that is free, so adding is one keypress. */
export function suggestRouteName(existing: readonly string[]): string {
  const taken = new Set(existing);
  for (let index = 1; index < 1000; index++) {
    const candidate = `route-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return "route";
}

// ── Model catalog ────────────────────────────────────────────────────────────

/** The catalog fields the picker needs; keeps this module free of Pi imports. */
export type RouterModelInfo = {
  provider: string;
  id: string;
  name?: string;
  /** Non-chat catalog entries cannot serve a routed chat request. */
  type?: string;
  /** Virtual models carry `pi-virtual`; a route target must be physical. */
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: readonly string[];
};

/** Token counts the way `/models` prints them, so the two lists read alike. */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const thousands = count / 1_000;
    return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
  }
  return String(count);
}

/**
 * The facts `/models` prints for a model, in the same order.
 *
 * A picker that is choosing a route target has to answer "can this model do the
 * job this route needs", and context, output limit, thinking and image input
 * are exactly what decides that.
 */
export function describeModelFacts(model: RouterModelInfo): string {
  const facts: string[] = [];
  if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
    facts.push(`${formatTokens(model.contextWindow)} ctx`);
  }
  if (typeof model.maxTokens === "number" && model.maxTokens > 0) {
    facts.push(`${formatTokens(model.maxTokens)} out`);
  }
  if (model.reasoning === true) facts.push("thinking");
  if (model.input?.includes("image")) facts.push("images");
  return facts.join(" · ");
}

/**
 * Models a route may target, as `provider/model` choices.
 *
 * The router's own virtual models and pool shadow providers are excluded: a
 * route that targeted a route would loop, and a pool is expressed with the
 * target's `pool` field so its strategy and health stay in play.
 */
export function routerModelChoices(
  models: readonly RouterModelInfo[],
  options: { excludeProviders?: readonly string[] } = {},
): ModelChoice[] {
  const excluded = new Set(options.excludeProviders ?? []);
  const seen = new Set<string>();
  const choices: ModelChoice[] = [];
  for (const model of models) {
    const provider = model?.provider?.trim();
    const id = model?.id?.trim();
    if (!provider || !id) continue;
    if (excluded.has(provider) || provider.startsWith("pool:")) continue;
    if (model.api === "pi-virtual") continue;
    if (model.type !== undefined && model.type !== "chat") continue;
    const key = `${provider}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const detail = describeModelFacts(model);
    choices.push({ id: key, name: model.name ?? id, ...(detail ? { detail } : {}) });
  }
  return choices.sort((a, b) => a.id.localeCompare(b.id));
}

/** Classify a failed request for a route trigger, from its error text. */
export function classifyFailure(error: string | undefined): RouteFailureClass {
  const text = (error ?? "").toLowerCase();
  if (!text) return "other";
  if (/context[_ ]?(length|window)|maximum context|too many tokens|prompt is too long|input is too long|context overflow/.test(text)) {
    return "overflow";
  }
  if (/\b429\b|rate.?limit|quota|resource.?exhausted|too many requests|insufficient.?quota/.test(text)) return "quota";
  return "other";
}
