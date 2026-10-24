import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { endpoint, type ProviderConfig } from "./provider-config.ts";

/** Only these deliberately non-sensitive errors may be displayed to the user. */
export class DiscoveryError extends Error {}

export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
}

type DiscoveryAuth = { apiKey?: string; headers?: Record<string, string | null> };
export type DiscoveryOptions = DiscoveryAuth & {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Discovery never executes !commands. Support Pi's literals and env interpolation. */
export function discoveryValue(value: unknown, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof value !== "string" || value.startsWith("!")) {
    throw new DiscoveryError("Command-based or unsupported authentication needs manual model entry.");
  }
  return value.replace(/\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced, bare) => {
      if (match === "$$") return "$";
      if (match === "$!") return "!";
      const resolved = env[braced ?? bare];
      if (!resolved) throw new DiscoveryError("An authentication environment variable is unset. Export it before starting Pi.");
      return resolved;
    });
}

/** Resolve secrets only inside the process, after endpoint trust has been confirmed. */
export async function discoveryAuth(registry: ModelRegistry, id: string, config: ProviderConfig): Promise<DiscoveryAuth> {
  if (registry.getRegisteredProviderIds().includes(id)) {
    throw new DiscoveryError("Extension-owned providers need manual entry or their own model discovery.");
  }
  // Check config first so even resolving stored auth cannot incidentally execute commands.
  const headers: Record<string, string> = {};
  if (config.headers !== undefined) {
    if (!object(config.headers)) throw new DiscoveryError("Unsupported headers need manual model entry.");
    for (const [name, value] of Object.entries(config.headers)) headers[name] = discoveryValue(value);
  }
  if (typeof config.apiKey === "string" && config.apiKey.startsWith("!")) {
    throw new DiscoveryError("Command-based authentication needs manual model entry.");
  }
  const status = registry.getProviderAuthStatus(id);
  const native = status.source === "stored" || status.source === "runtime" ||
    (config.apiKey === undefined && status.configured);
  if (native) {
    // OAuth catalogs can require service-specific endpoints/scopes; don't guess or refresh them.
    if (registry.getProvider(id)?.auth.oauth) {
      throw new DiscoveryError("OAuth providers need manual entry or their own model discovery.");
    }
    const resolved = await registry.getProviderAuth(id);
    if (!resolved) throw new DiscoveryError("Log in to this provider before retrying model discovery.");
    if (resolved.auth.baseUrl && endpoint(resolved.auth.baseUrl) !== endpoint(String(config.baseUrl))) {
      throw new DiscoveryError("Authentication uses a different endpoint. Use manual model entry.");
    }
    return { apiKey: resolved.auth.apiKey, headers: { ...resolved.auth.headers, ...headers } };
  }
  return { apiKey: config.apiKey === undefined ? undefined : discoveryValue(config.apiKey), headers };
}

export function modelsEndpoint(config: ProviderConfig): URL {
  if (typeof config.baseUrl !== "string") throw new DiscoveryError("No explicit endpoint is configured.");
  const url = new URL(endpoint(config.baseUrl));
  if (config.api === "anthropic-messages") {
    // Anthropic SDK bases normally omit /v1; gateways may already include it.
    if (!url.pathname.endsWith("/v1")) url.pathname = `${url.pathname.replace(/\/$/, "")}/v1`;
  } else if (config.api === "google-generative-ai") {
    if (url.pathname === "/") url.pathname = "/v1beta";
  } else if (config.api !== "openai-completions" && config.api !== "openai-responses") {
    throw new DiscoveryError("This API has no supported model-list endpoint.");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/models`;
  return url;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value === value.trim() && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value);
}

function positiveInteger(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function modelDetails(id: string, item: Record<string, unknown>, api: unknown): DiscoveredModel {
  const model: DiscoveredModel = { id };
  const google = api === "google-generative-ai";
  const name = google ? item.displayName : api === "anthropic-messages" ? item.display_name : item.name;
  if (validId(name)) model.name = name;
  const topProvider = object(item.top_provider) ? item.top_provider : {};
  // Gemini's input limit is a conservative context ceiling, not input + output.
  const contextWindow = google ? positiveInteger(item.inputTokenLimit) : positiveInteger(
    item.context_length, item.context_window, item.contextWindow, item.max_model_len, topProvider.context_length,
  );
  const maxTokens = google ? positiveInteger(item.outputTokenLimit) : positiveInteger(
    item.max_output_tokens, item.maxTokens, topProvider.max_completion_tokens,
  );
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  if (maxTokens !== undefined) model.maxTokens = maxTokens;
  // Only explicit capability declarations count; names and model IDs are never evidence.
  if (typeof item.reasoning === "boolean") model.reasoning = item.reasoning;
  else if (typeof item.supports_reasoning === "boolean") model.reasoning = item.supports_reasoning;
  else if (Array.isArray(item.supported_parameters) && item.supported_parameters.includes("reasoning")) model.reasoning = true;
  const architecture = object(item.architecture) ? item.architecture : {};
  const modalities = [item.input, architecture.input_modalities].filter(Array.isArray).flat();
  const input = (["text", "image"] as const).filter(modality => modalities.includes(modality));
  if (input.length) model.input = input;
  return model;
}

/** First valid scalar wins; later duplicates fill gaps and union explicit input capabilities. */
function mergeDetails(previous: DiscoveredModel, next: DiscoveredModel): DiscoveredModel {
  const merged = { ...next, ...previous };
  if (previous.input || next.input) {
    merged.input = (["text", "image"] as const).filter(modality =>
      previous.input?.includes(modality) || next.input?.includes(modality));
  }
  return merged;
}

/** Bounded read-only requests; no redirects, inference, command execution or payload logging. */
export async function discoverModelDetails(config: ProviderConfig, options: DiscoveryOptions = {}): Promise<DiscoveredModel[]> {
  const url = modelsEndpoint(config);
  const headers = new Headers({ Accept: "application/json" });
  if (config.api === "anthropic-messages") {
    headers.set("anthropic-version", "2023-06-01");
    if (options.apiKey) headers.set("x-api-key", options.apiKey);
    if (options.apiKey && config.authHeader === true) headers.set("Authorization", `Bearer ${options.apiKey}`);
  } else if (config.api === "google-generative-ai") {
    if (options.apiKey) headers.set("x-goog-api-key", options.apiKey);
  } else if (options.apiKey) headers.set("Authorization", `Bearer ${options.apiKey}`);
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 5000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const fetcher = options.fetch ?? globalThis.fetch;
  const models = new Map<string, DiscoveredModel>();
  const cursors = new Set<string>();
  let bytes = 0;
  for (let page = 0; page < 10; page++) {
    const response = await fetcher(url, { method: "GET", headers, redirect: "error", signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DiscoveryError(`The model-list endpoint returned HTTP ${response.status}.`);
    }
    const chunks: Uint8Array[] = [];
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 2 * 1024 * 1024) throw new DiscoveryError("The model list is too large; use manual entry.");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    let payload: unknown;
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new DiscoveryError("The endpoint did not return a JSON model list."); }
    if (!object(payload)) throw new DiscoveryError("The endpoint did not return a supported model list.");
    const google = config.api === "google-generative-ai";
    const entries = google ? payload.models : payload.data;
    if (!Array.isArray(entries)) throw new DiscoveryError("The endpoint did not return a supported model list.");
    for (const item of entries) {
      if (!object(item)) continue;
      if (google && Array.isArray(item.supportedGenerationMethods) &&
        !item.supportedGenerationMethods.includes("generateContent")) continue;
      const id = google && typeof item.name === "string" ? item.name.replace(/^models\//, "") : item.id;
      if (validId(id)) {
        const details = modelDetails(id, item, config.api);
        const previous = models.get(id);
        models.set(id, previous ? mergeDetails(previous, details) : details);
      }
      if (models.size > 2000) throw new DiscoveryError("The model list is too large; use manual entry.");
    }
    const cursor = google ? payload.nextPageToken : payload.has_more === true ? payload.last_id : undefined;
    if (!google && payload.has_more === true && (cursor === undefined || cursor === "")) {
      throw new DiscoveryError("The model list has unsupported pagination; use manual entry.");
    }
    if (cursor === undefined || cursor === "") {
      if (!models.size) throw new DiscoveryError("The endpoint returned no usable models.");
      return [...models.keys()].sort().map(id => models.get(id)!);
    }
    if (typeof cursor !== "string" || cursor.length > 4096 || cursors.has(cursor)) {
      throw new DiscoveryError("The model list has unsupported pagination; use manual entry.");
    }
    cursors.add(cursor);
    // Never follow server-supplied links; only encode a cursor on the same endpoint.
    url.searchParams.set(google ? "pageToken" : "after_id", cursor);
  }
  throw new DiscoveryError("The model list has too many pages; use manual entry.");
}

/** Backward-compatible ID-only view of the same single discovery pass. */
export async function discoverModels(config: ProviderConfig, options: DiscoveryOptions = {}): Promise<string[]> {
  return (await discoverModelDetails(config, options)).map(model => model.id);
}
