// Antigravity, one provider per linked Google account.
//
// Instead of a single `antigravity` provider whose active login is switched by
// hand (or rewritten behind your back on a quota wall), every linked account is
// registered as its own provider:
//
//   antigravity-1   antigravity-2   …   antigravity-n
//
// Each appears in `/model` like any other provider, pins exactly one credential
// for every request, and never mutates another account's active login. Pick the
// account the same way you pick a model.
//
// Numbering follows the account store's stable order (link time, then id), so it
// does not shuffle between sessions. Use `/antigravity` to see the mapping.
//
// The Antigravity implementation itself is vendored under `vendor/antigravity`
// (see its VENDORED.md); this package no longer depends on the npm
// `pi-antigravity` package.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type Api, type AssistantMessage, type AssistantMessageEvent, type Model,
} from "@earendil-works/pi-ai/compat";
import { DEFAULT_ENDPOINT, defaultProjectId } from "../vendor/antigravity/client/client.ts";
import {
  ANTIGRAVITY_API, type AntigravityStreamOptions,
} from "../vendor/antigravity/types/types.ts";
import {
  PROVIDER_NAME, getCurrentAntigravityCatalog,
} from "../vendor/antigravity/models/models.ts";
import { streamAntigravity } from "../vendor/antigravity/stream/stream.ts";
import {
  ANTIGRAVITY_IMAGE_API, ANTIGRAVITY_IMAGE_MODELS, generateAntigravityImages,
} from "../vendor/antigravity/image/native.ts";
import { loginAntigravity, refreshAntigravityToken } from "../vendor/antigravity/auth/oauth.ts";
import { rememberAccount, updateRememberedAccount } from "../vendor/antigravity/auth/accounts.ts";
import type { AntigravityOAuthCredentials } from "../vendor/antigravity/types/types.ts";

/** Provider id prefix; account `n` (1-based) becomes `antigravity-n`. */
export const PROVIDER_PREFIX = "antigravity-";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const COMMAND = "antigravity";
const ACCOUNTS_FILE = "antigravity-accounts.json";

/** One linked login, in its stable slot. */
export type AccountSlot = {
  /** 1-based slot, as shown in the provider id. */
  index: number;
  provider: string;
  accountId: string;
  email?: string;
  access?: string;
  refresh: string;
  expires?: number;
  projectId?: string;
  addedAt: number;
  lastUsedAt: number;
};

/** Provider id for a 1-based account slot. */
export function providerForIndex(index: number): string {
  return `${PROVIDER_PREFIX}${index}`;
}

/** Parse `antigravity-N` back to N, or undefined for any other provider id. */
export function indexForProvider(providerId: string): number | undefined {
  if (!providerId.startsWith(PROVIDER_PREFIX)) return undefined;
  const suffix = providerId.slice(PROVIDER_PREFIX.length);
  if (!/^[1-9][0-9]*$/.test(suffix)) return undefined;
  return Number(suffix);
}

/** Display label for a slot: the email when present, else the account id. */
export function slotLabel(slot: { email?: string; accountId: string }): string {
  const email = slot.email?.trim();
  return email || slot.accountId;
}

/**
 * Read linked accounts in stable slot order without touching `auth.json`.
 * Accounts without a refresh token cannot be used and are skipped.
 */
export function readAccountSlots(agentDir: string): AccountSlot[] {
  let parsed: unknown;
  try {
    const path = join(agentDir, ACCOUNTS_FILE);
    if (!existsSync(path)) return [];
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const accounts = (parsed as { accounts?: unknown } | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return [];
  const entries: Omit<AccountSlot, "index" | "provider">[] = [];
  for (const [key, raw] of Object.entries(accounts as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const account = raw as Record<string, unknown>;
    if (typeof account.refresh !== "string" || !account.refresh) continue;
    entries.push({
      accountId: typeof account.accountId === "string" && account.accountId ? account.accountId : key,
      ...(typeof account.email === "string" ? { email: account.email } : {}),
      ...(typeof account.access === "string" ? { access: account.access } : {}),
      refresh: account.refresh,
      ...(typeof account.expires === "number" ? { expires: account.expires } : {}),
      ...(typeof account.projectId === "string" ? { projectId: account.projectId } : {}),
      addedAt: typeof account.addedAt === "number" ? account.addedAt : 0,
      lastUsedAt: typeof account.lastUsedAt === "number" ? account.lastUsedAt : 0,
    });
  }
  entries.sort((a, b) => a.addedAt - b.addedAt || a.accountId.localeCompare(b.accountId));
  return entries.map((entry, position) => ({
    ...entry,
    index: position + 1,
    provider: providerForIndex(position + 1),
  }));
}

/**
 * The credential envelope Antigravity expects: this account's access token plus
 * its project. Built per request so no token is ever shared between slots.
 */
export function credentialEnvelope(account: {
  access?: string; projectId?: string; email?: string;
}): string {
  const email = account.email?.trim();
  return JSON.stringify({
    token: account.access,
    projectId: account.projectId || defaultProjectId(email || "antigravity-default"),
  });
}

/**
 * A request-scoped credential is the JSON envelope `parseApiKey` expects.
 *
 * Anything else is not a credential. In particular `"account-managed"` is the
 * placeholder this extension registers so Pi keeps the provider "configured";
 * Pi can hand that placeholder back as `options.apiKey`, and forwarding it made
 * the vendored client throw `"account-managed" is not valid JSON`.
 */
export function isCredentialEnvelope(value: unknown): value is string {
  if (typeof value !== "string" || !value.trimStart().startsWith("{")) return false;
  try {
    const parsed = JSON.parse(value) as { token?: unknown; projectId?: unknown };
    return typeof parsed.token === "string" && parsed.token.length > 0 &&
      typeof parsed.projectId === "string" && parsed.projectId.length > 0;
  } catch {
    return false;
  }
}

/** True when an access token can be used for a request right now. */
export function slotIsFresh(
  account: { access?: string; expires?: number }, now = Date.now(), skewMs = REFRESH_SKEW_MS,
): boolean {
  return typeof account.access === "string" && account.access.length > 0 &&
    typeof account.expires === "number" && account.expires > now + skewMs;
}

/**
 * Adapt Pi's extension UI to the OAuth callbacks loginAntigravity() drives. Pi's
 * `ctx.ui` has no onAuth/onPrompt, so handing it over unchanged made the login
 * throw before the browser was ever opened.
 */
export function loginCallbacks(
  ui: ExtensionContext["ui"], signal: AbortSignal,
): Parameters<typeof loginAntigravity>[0] {
  return {
    signal,
    onAuth: ({ url, instructions }) => {
      ui.notify(`Open this URL to sign in to Google:\n${url}${instructions ? `\n\n${instructions}` : ""}`, "info");
    },
    onDeviceCode: ({ verificationUri, userCode }) => {
      ui.notify(`Enter code ${userCode} at ${verificationUri}`, "info");
    },
    onPrompt: async ({ message, placeholder }) => {
      const text = await ui.input(message, placeholder, { signal });
      if (text === undefined) throw new Error("Login cancelled");
      return text;
    },
    onSelect: async ({ message, options }) => {
      const label = await ui.select(message, options.map((option) => option.label), { signal });
      return options.find((option) => option.label === label)?.id;
    },
    onProgress: (message) => ui.notify(message, "info"),
  };
}

export default function antigravityAccountsExtension(pi: ExtensionAPI): void {
  const agentDir = (() => {
    try { return getAgentDir(); } catch { return join(process.env.HOME ?? "", ".pi", "agent"); }
  })();

  let slots: AccountSlot[] = [];
  let configErrors: string[] = [];
  let lastError: string | undefined;
  let uiCtx: ExtensionContext | undefined;
  /** Refreshed access tokens per slot; never shared across slots. */
  const refreshed = new Map<number, { access: string; expires: number }>();
  const registered = new Set<string>();

  // A pinned provider must not silently switch accounts: the vendored stream
  // would otherwise rewrite auth.json's active login mid-request. Report the
  // quota wall instead, so the account you chose stays the account used.
  process.env.ANTIGRAVITY_NO_ACCOUNT_FAILOVER ??= "1";

  /** Fresh credential envelope for one slot, refreshing and persisting if needed. */
  const credentialFor = async (slot: AccountSlot): Promise<string> => {
    const cached = refreshed.get(slot.index);
    const merged = {
      access: cached?.access ?? slot.access,
      expires: cached?.expires ?? slot.expires,
      projectId: slot.projectId,
      email: slot.email,
    };
    if (slotIsFresh(merged, Date.now(), 0)) return credentialEnvelope(merged);

    const credentials = await refreshAntigravityToken({
      access: merged.access ?? "",
      refresh: slot.refresh,
      expires: merged.expires ?? 0,
      ...(merged.projectId ? { projectId: merged.projectId } : {}),
      ...(merged.email ? { email: merged.email } : {}),
    }) as AntigravityOAuthCredentials;
    if (typeof credentials?.access !== "string" || !credentials.access) {
      throw new Error(
        `Antigravity account ${slot.index} (${slotLabel(slot)}) needs re-login: /antigravity login`,
      );
    }
    const expires = typeof credentials.expires === "number"
      ? credentials.expires
      : Date.now() + REFRESH_SKEW_MS + 60_000;
    refreshed.set(slot.index, { access: credentials.access, expires });
    const projectId = credentials.projectId ?? merged.projectId;
    if (projectId) slot.projectId = projectId;
    slot.access = credentials.access;
    slot.expires = expires;
    // Keep the store in step so the next session starts with the fresh token.
    try {
      updateRememberedAccount(
        { access: merged.access ?? "", refresh: slot.refresh, expires: merged.expires ?? 0 } as never,
        credentials,
      );
    } catch {
      // A store write failure must not fail the request; the token still works.
    }
    return credentialEnvelope({
      access: credentials.access,
      ...(projectId ? { projectId } : {}),
      ...(merged.email ? { email: merged.email } : {}),
    });
  };

  /**
   * Forward events from the vendored stream, resolving the slot's credential
   * first. The stream object is returned synchronously, as Pi requires; the
   * credential is awaited inside it so a slow refresh cannot block the caller.
   */
  const startStream = (
    slot: AccountSlot,
    model: Model<Api>,
    context: never,
    options: Record<string, unknown> | undefined,
  ) => {
    const stream = createAssistantMessageEventStream();
    const abort = options?.signal as AbortSignal | undefined;
    // A request-scoped credential is an explicit override and must win, the way
    // Pi's own auth resolution treats it. A pool fronting these accounts picks
    // an account per request and passes that credential here; ignoring it would
    // silently bill the pinned slot instead of the selected one. Only a real
    // envelope counts: Pi also hands back the `"account-managed"` registration
    // placeholder, which is not a credential.
    const override = isCredentialEnvelope(options?.apiKey) ? options.apiKey : undefined;
    void (async () => {
      try {
        const apiKey = override ?? await credentialFor(slot);
        const inner = streamAntigravity(model as never, context, {
          ...options,
          apiKey,
        } as AntigravityStreamOptions);
        let final: AssistantMessage | undefined;
        for await (const event of inner as AsyncIterable<AssistantMessageEvent>) {
          if (event.type === "done" && event.message?.usage && (!event.message.usage.cost || typeof event.message.usage.cost.total === "undefined")) {
            event.message.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
          } else if (event.type === "error" && event.error?.usage && (!event.error.usage.cost || typeof event.error.usage.cost.total === "undefined")) {
            event.error.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
          }
          stream.push(event);
          if (event.type === "done") final = event.message;
          else if (event.type === "error") final = event.error;
        }
        if (final?.usage && (!final.usage.cost || typeof final.usage.cost.total === "undefined")) {
          final.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        }
        if (!final) throw new Error("Antigravity stream ended without a result");
        if (final.stopReason === "error" && final.errorMessage) {
          lastError = `${slot.provider}: ${final.errorMessage.slice(0, 300)}`;
        }
        stream.end(final);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = `${slot.provider}: ${message.slice(0, 300)}`;
        const failure: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: abort?.aborted ? "aborted" : "error",
          errorMessage: message,
          timestamp: Date.now(),
        };
        stream.push({ type: "error", reason: abort?.aborted ? "aborted" : "error", error: failure });
        stream.end(failure);
      }
    })();
    return stream;
  };

  /** Model definitions shared by every account provider. */
  const providerModels = () =>
    [...getCurrentAntigravityCatalog().models, ...ANTIGRAVITY_IMAGE_MODELS] as never;

  /** Register one provider per linked account. */
  const register = (ctx?: ExtensionContext): void => {
    slots = readAccountSlots(agentDir);
    configErrors = [];
    for (const slot of slots) {
      const name = `${PROVIDER_NAME} ${slot.index} (${slotLabel(slot)})`;
      try {
        pi.registerProvider(slot.provider, {
          name,
          baseUrl: DEFAULT_ENDPOINT,
          api: ANTIGRAVITY_API as never,
          // Replaced on every request by credentialFor(); a literal keeps the
          // provider "configured" so Pi never filters an account out.
          apiKey: "account-managed",
          models: providerModels(),
          streamSimple: ((model: Model<Api>, context: never, options?: Record<string, unknown>) =>
            startStream(slot, model, context, options)) as never,
          images: {
            [ANTIGRAVITY_IMAGE_API]: {
              generateImages: (async (
                model: never, context: never, options?: Record<string, unknown>,
              ) => generateAntigravityImages(model, context, {
                ...options,
                apiKey: await credentialFor(slot),
              } as never)) as never,
            },
          },
        } as never);
        registered.add(slot.provider);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        configErrors.push(`${slot.provider}: ${message}`);
      }
    }
    void ctx;
  };

  const emit = (ctx: ExtensionCommandContext, text: string, type: "info" | "warning" | "error" = "info"): void => {
    if (ctx.hasUI) { ctx.ui.notify(text, type); return; }
    if (type === "info") console.log(text); else console.error(text);
  };

  const formatSlots = (): string => {
    if (!slots.length) {
      return [
        "No linked Antigravity accounts.",
        "Run /antigravity login to add one. Each linked account appears as antigravity-1, antigravity-2, …",
      ].join("\n");
    }
    const lines = [`Linked Antigravity accounts (${slots.length}):`];
    for (const slot of slots) {
      const health = slotIsFresh(slot, Date.now(), 0)
        ? "ready"
        : slotIsFresh(slot)
          ? "refreshing soon"
          : "token expired (refreshes on use)";
      const project = slot.projectId ? ` project=${slot.projectId}` : "";
      lines.push(`  ${slot.provider.padEnd(15)} ${slotLabel(slot)}${project} — ${health}`);
    }
    lines.push("Select the account in /model like any provider.");
    if (configErrors.length) lines.push(`Warnings:\n${configErrors.map((line) => `  ${line}`).join("\n")}`);
    if (lastError) lines.push(`Last error: ${lastError}`);
    return lines.join("\n");
  };

  // Register linked accounts during extension loading so they are queued in
  // pendingProviderRegistrations and available before Pi resolves scoped models.
  register();

  // ── Events ─────────────────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    uiCtx = ctx;
    register(ctx);
  });

  pi.on("session_tree", (_event, ctx) => { uiCtx = ctx; register(ctx); });

  pi.on("session_shutdown", () => { uiCtx = undefined; });

  // ── Command ────────────────────────────────────────────────────────────────

  pi.registerCommand(COMMAND, {
    description: "Antigravity accounts: list, login, remove, refresh",
    handler: async (args, ctx) => {
      const input = (args ?? "").trim();
      const [verb, ...rest] = input.split(/\s+/).filter(Boolean);
      const arg = rest.join(" ");
      switch (verb) {
        case undefined:
        case "list":
        case "status":
          emit(ctx, formatSlots());
          return;
        case "login": {
          // Dismisses the paste prompt once the browser callback wins the race.
          const dialogs = new AbortController();
          try {
            const credentials = await loginAntigravity(loginCallbacks(ctx.ui, dialogs.signal));
            const stored = rememberAccount(credentials);
            refreshed.clear();
            register(ctx);
            const slot = slots.find((entry) => entry.accountId === stored.accountId);
            emit(ctx, slot
              ? `Linked ${slotLabel(slot)} as ${slot.provider}.`
              : `Linked ${slotLabel(stored)}.`);
          } catch (error) {
            emit(ctx, `Antigravity login failed: ${error instanceof Error ? error.message : String(error)}`, "error");
          } finally {
            dialogs.abort();
          }
          return;
        }
        case "remove": {
          const slot = arg
            ? slots.find((entry) => entry.provider === arg || String(entry.index) === arg ||
                entry.accountId === arg || entry.email === arg)
            : undefined;
          if (!slot) {
            emit(ctx, arg
              ? `No account matches "${arg}". Run /antigravity to list them.`
              : "Usage: /antigravity remove <number|email|antigravity-N>", "warning");
            return;
          }
          // Remove from the store directly: the vendored removeAccount() also
          // rewrites auth.json's active credential, which these providers never use.
          try {
            const path = join(agentDir, ACCOUNTS_FILE);
            const store = JSON.parse(readFileSync(path, "utf8")) as {
              accounts?: Record<string, unknown>; activeAccountId?: string;
            };
            if (store.accounts) delete store.accounts[slot.accountId];
            if (store.activeAccountId === slot.accountId) delete store.activeAccountId;
            const { writeFileSync, chmodSync, renameSync } = await import("node:fs");
            const temp = `${path}.${process.pid}.tmp`;
            writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
            chmodSync(temp, 0o600);
            renameSync(temp, path);
          } catch (error) {
            emit(ctx, `Could not remove ${slotLabel(slot)}: ${error instanceof Error ? error.message : String(error)}`, "error");
            return;
          }
          refreshed.delete(slot.index);
          if (uiCtx) pi.unregisterProvider(slot.provider);
          registered.delete(slot.provider);
          register(uiCtx);
          emit(ctx, `Removed ${slotLabel(slot)}. Remaining accounts were renumbered; run /antigravity to see them.`);
          return;
        }
        case "refresh": {
          refreshed.clear();
          let ok = 0;
          const failures: string[] = [];
          for (const slot of slots) {
            try { await credentialFor(slot); ok++; }
            catch (error) {
              failures.push(`${slot.provider}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          emit(ctx, [
            `Refreshed ${ok}/${slots.length} Antigravity account(s).`,
            ...failures.map((line) => `  ${line}`),
          ].join("\n"), failures.length ? "warning" : "info");
          return;
        }
        case "help":
          emit(ctx, [
            "Antigravity accounts (one provider per linked Google account):",
            "  /antigravity                 list accounts and their provider ids",
            "  /antigravity login           link another Google account",
            "  /antigravity remove <id>     unlink an account (others renumber)",
            "  /antigravity refresh         refresh access tokens now",
            "",
            "Each account is a separate provider: antigravity-1, antigravity-2, …",
            "Pick it in /model. No manual account switching.",
          ].join("\n"));
          return;
        default:
          emit(ctx, `Unknown subcommand "${verb}". Try /antigravity help.`, "warning");
      }
    },
  });

  void uiCtx;
  void registered;
}
