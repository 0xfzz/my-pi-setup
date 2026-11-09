// Prompt-cache accounting for the sidebar.
//
// Providers report a request's prompt as three disjoint parts: `input` (new,
// uncached), `cacheRead` (served from cache, ~10% price on Anthropic) and
// `cacheWrite` (stored this turn, ~125% price). The hit rate is the share of the
// prompt that came from cache. It is the number that explains a fast usage
// drain: a healthy long session sits above ~90%, a prefix that keeps changing
// sits near zero.

export interface CacheUsage {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface CacheSample {
  /** Prompt tokens of the request (input + cacheRead + cacheWrite). */
  prompt: number;
  read: number;
  write: number;
  /** Uncached tokens billed at full price. */
  fresh: number;
  /** 0..1, or undefined when the provider reported no prompt tokens. */
  hitRate: number | undefined;
}

export interface CacheTotals {
  requests: number;
  prompt: number;
  read: number;
  write: number;
  fresh: number;
}

const n = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** Measure one request. Returns undefined when the usage carries no prompt tokens. */
export function sampleOf(usage: CacheUsage | undefined): CacheSample | undefined {
  if (!usage) return undefined;
  const fresh = n(usage.input);
  const read = n(usage.cacheRead);
  const write = n(usage.cacheWrite);
  const prompt = fresh + read + write;
  if (prompt === 0) return undefined;
  return { prompt, read, write, fresh, hitRate: read / prompt };
}

export const emptyTotals = (): CacheTotals => ({ requests: 0, prompt: 0, read: 0, write: 0, fresh: 0 });

export function addSample(totals: CacheTotals, sample: CacheSample): CacheTotals {
  return {
    requests: totals.requests + 1,
    prompt: totals.prompt + sample.prompt,
    read: totals.read + sample.read,
    write: totals.write + sample.write,
    fresh: totals.fresh + sample.fresh,
  };
}

/** Compact token count: 842, 1.2k, 18k, 1.4M. */
export function tokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

const percent = (ratio: number | undefined): string => (ratio === undefined ? "–" : `${Math.round(ratio * 100)}%`);

/** A miss worth flagging: a large prompt that mostly paid full price. */
export function isCostlyMiss(sample: CacheSample | undefined): boolean {
  return !!sample && sample.prompt >= 4000 && (sample.hitRate ?? 0) < 0.5;
}

export interface CacheRows {
  rows: string[];
  tone: "success" | "warning" | undefined;
}

/**
 * Sidebar rows. The first row is the answer to "did the last request hit the
 * cache?", the second the session trend, the third (only on a miss) what the
 * miss cost.
 */
export function cacheRows(last: CacheSample | undefined, totals: CacheTotals): CacheRows {
  if (!last) return { rows: [], tone: undefined };
  const rows = [`last ${percent(last.hitRate)} hit · ${tokens(last.read)} read`];
  const sessionRate = totals.prompt ? totals.read / totals.prompt : undefined;
  rows.push(`session ${percent(sessionRate)} · ${totals.requests} req`);
  if (last.read === 0 && last.write === 0) {
    rows.push("provider reports no cache");
    return { rows, tone: undefined };
  }
  if (isCostlyMiss(last)) {
    rows.push(`miss: ${tokens(last.fresh)} new${last.write ? ` · ${tokens(last.write)} written` : ""}`);
    return { rows, tone: "warning" };
  }
  return { rows, tone: (last.hitRate ?? 0) >= 0.8 ? "success" : undefined };
}

export interface CacheWebRow {
  label: string;
  value: string;
}

export interface CacheWebView {
  title: string;
  rows: CacheWebRow[];
}

/**
 * The same facts as {@link cacheRows}, shaped as label/value rows for the web
 * plugin surface. The first row is what a compact strip shows, so it answers
 * "did the last request hit the cache?" on its own.
 */
export function cacheWebView(last: CacheSample | undefined, totals: CacheTotals): CacheWebView {
  if (!last) {
    return { title: "Cache", rows: [{ label: "Status", value: "No prompt-cache data yet" }] };
  }
  const rows: CacheWebRow[] = [
    { label: "Last request", value: `${percent(last.hitRate)} hit · ${tokens(last.read)} read` },
    { label: "Session", value: `${percent(totals.prompt ? totals.read / totals.prompt : undefined)} · ${totals.requests} req` },
  ];
  if (last.read === 0 && last.write === 0) {
    rows.push({ label: "Provider", value: "reports no cache" });
  } else if (isCostlyMiss(last)) {
    rows.push({ label: "Miss", value: `${tokens(last.fresh)} new${last.write ? ` · ${tokens(last.write)} written` : ""}` });
  }
  return { title: `Cache ${percent(last.hitRate)}`, rows };
}
