/**
 * Merge manifest-discovered browser halves into the trusted runtime before its
 * first scan. Bundles are fetched and hash-verified in parallel, then handed
 * to one batched registration so a page load pays one status round trip.
 */
import {
  BROWSER_HALVES_API,
  isBrowserHalfMetadata,
  type BrowserHalfMetadata,
} from "../../shared/browser-halves.ts";
import { getJson } from "./api-client.ts";
import {
  prepareBrowserHalfFromUrl,
  type BrowserHalfDefinition,
  type BrowserHalfSourceInfo,
  type BrowserRuntime,
} from "./browser-host.ts";

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
  readonly prepare?: (info: BrowserHalfSourceInfo) => Promise<BrowserHalfDefinition>;
  readonly addDefinitions?: (definitions: readonly BrowserHalfDefinition[]) => Promise<void>;
  readonly staticIds?: readonly string[];
}

interface Candidate {
  readonly id: string;
  readonly info: BrowserHalfSourceInfo;
}

interface Selection {
  readonly candidates: readonly Candidate[];
  readonly skipped: readonly string[];
  readonly errors: string[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultFetchHalves(): Promise<MetadataResult> {
  return getJson<{ halves: unknown }>(BROWSER_HALVES_API);
}

function requestFor(half: BrowserHalfMetadata): BrowserHalfSourceInfo {
  return {
    id: half.id,
    version: half.version,
    sourcePath: half.sourcePath,
    capabilities: half.capabilities,
    trust: "trusted",
    ...(half.corePlugin === true ? { corePlugin: true } : {}),
    url: half.url,
    expectedHash: half.hash,
  };
}

function selectCandidates(values: readonly unknown[], staticIds: ReadonlySet<string>): Selection {
  const candidates: Candidate[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  for (const value of values) {
    if (!isBrowserHalfMetadata(value)) {
      errors.push("discarded a malformed browser-half declaration");
      continue;
    }
    if (staticIds.has(value.id) || value.trust !== "trusted") {
      skipped.push(value.id);
      continue;
    }
    candidates.push({ id: value.id, info: requestFor(value) });
  }
  return { candidates, skipped, errors };
}

type PrepareHalf = (info: BrowserHalfSourceInfo) => Promise<BrowserHalfDefinition>;

async function prepareCandidate(
  prepare: PrepareHalf,
  candidate: Candidate,
): Promise<{ readonly definition: BrowserHalfDefinition } | { readonly error: string }> {
  try {
    return { definition: await prepare(candidate.info) };
  } catch (error) {
    return { error: `${candidate.id}: ${errorText(error)}` };
  }
}

async function registerBatch(
  addDefinitions: NonNullable<DiscoveredHalvesOptions["addDefinitions"]>,
  definitions: readonly BrowserHalfDefinition[],
  skipped: readonly string[],
  errors: readonly string[],
): Promise<DiscoveredHalvesReport> {
  try {
    // Always scan, even with an empty batch: the host may have static halves.
    await addDefinitions(definitions);
    return { registered: definitions.map((definition) => definition.id), skipped, errors };
  } catch (error) {
    return { registered: [], skipped, errors: [...errors, `registration failed: ${errorText(error)}`] };
  }
}

/** Individual failures are reported, never allowed to stop other halves. */
export async function registerDiscoveredBrowserHalves(
  runtime: BrowserRuntime,
  options: DiscoveredHalvesOptions = {},
): Promise<DiscoveredHalvesReport> {
  const fetchHalves = options.fetchHalves ?? defaultFetchHalves;
  const prepare: NonNullable<DiscoveredHalvesOptions["prepare"]> = options.prepare ?? prepareBrowserHalfFromUrl;
  const addDefinitions: NonNullable<DiscoveredHalvesOptions["addDefinitions"]> =
    options.addDefinitions ?? ((definitions) => runtime.addDefinitions(definitions));
  const result = await fetchHalves().catch((error: unknown) => ({ ok: false as const, error }));
  if (!result.ok) {
    return registerBatch(addDefinitions, [], [], [`metadata request failed: ${errorText(result.error ?? "unknown error")}`]);
  }

  const rawHalves = Array.isArray(result.data.halves) ? result.data.halves : [];
  const selection = selectCandidates(rawHalves, new Set(options.staticIds ?? []));
  const outcomes = await Promise.all(selection.candidates.map((candidate) => prepareCandidate(prepare, candidate)));
  const definitions: BrowserHalfDefinition[] = [];
  for (const outcome of outcomes) {
    if ("definition" in outcome) definitions.push(outcome.definition);
    else selection.errors.push(outcome.error);
  }
  return registerBatch(addDefinitions, definitions, selection.skipped, selection.errors);
}
