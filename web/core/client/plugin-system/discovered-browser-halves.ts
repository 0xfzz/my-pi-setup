/** Merge manifest-discovered browser halves into the trusted runtime before its first scan. */
import {
  BROWSER_HALVES_API,
  isBrowserHalfMetadata,
  type BrowserHalfMetadata,
} from "../../shared/browser-halves.ts";
import { getJson } from "./api-client.ts";
import { registerBrowserHalfFromUrl, type BrowserRuntime } from "./browser-host.ts";

type MetadataResult =
  | { readonly ok: true; readonly data: { readonly halves: unknown } }
  | { readonly ok: false; readonly error?: unknown };

export interface DiscoveredHalvesReport {
  readonly registered: readonly string[];
  readonly skipped: readonly string[];
  readonly errors: readonly string[];
}

export interface DiscoveredHalvesOptions {
  readonly fetchHalves?: () => Promise<MetadataResult>;
  readonly register?: typeof registerBrowserHalfFromUrl;
  readonly staticIds?: readonly string[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultFetchHalves(): Promise<MetadataResult> {
  return getJson<{ halves: unknown }>(BROWSER_HALVES_API);
}

function rows(data: { readonly halves: unknown }): readonly unknown[] {
  return Array.isArray(data.halves) ? data.halves : [];
}

async function registerOne(
  runtime: BrowserRuntime,
  half: BrowserHalfMetadata,
  register: typeof registerBrowserHalfFromUrl,
): Promise<void> {
  await register(runtime, {
    id: half.id,
    version: half.version,
    sourcePath: half.sourcePath,
    capabilities: half.capabilities,
    trust: "trusted",
    ...(half.corePlugin === true ? { corePlugin: true } : {}),
    url: half.url,
    expectedHash: half.hash,
  });
}

/** Individual failures are reported, never allowed to stop static halves. */
export async function registerDiscoveredBrowserHalves(
  runtime: BrowserRuntime,
  options: DiscoveredHalvesOptions = {},
): Promise<DiscoveredHalvesReport> {
  const fetchHalves = options.fetchHalves ?? defaultFetchHalves;
  const register = options.register ?? registerBrowserHalfFromUrl;
  const staticIds = new Set(options.staticIds ?? []);
  const registered: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  const result = await fetchHalves().catch((error: unknown) => ({ ok: false as const, error }));
  if (!result.ok) {
    errors.push(`metadata request failed: ${errorText(result.error ?? "unknown error")}`);
    return { registered, skipped, errors };
  }

  for (const value of rows(result.data)) {
    if (!isBrowserHalfMetadata(value)) {
      errors.push("discarded a malformed browser-half declaration");
      continue;
    }
    if (staticIds.has(value.id)) {
      skipped.push(value.id);
      continue;
    }
    if (value.trust !== "trusted") {
      skipped.push(value.id);
      continue;
    }
    try {
      await registerOne(runtime, value, register);
      registered.push(value.id);
    } catch (error) {
      errors.push(`${value.id}: ${errorText(error)}`);
    }
  }
  return { registered, skipped, errors };
}
