/**
 * `auth.read` / `auth.login` / `auth.state` / `auth.answer` / `auth.logout`
 * — pi's ModelRuntime credential flows, called natively.
 *
 * The web /login and /logout ports. pi's credential store is a shared file
 * (~/.pi/agent/auth.json); the facade runs pi's own ModelRuntime against it,
 * exactly like the `pi login` / `pi logout` CLI commands write the same file.
 * A login or logout therefore lands the same credential the TUI's runtime
 * reads on its next auth refresh.
 *
 * Login is interactive. A pending-login registry inside this module carries
 * each in-flight flow across HTTP requests:
 *
 *   auth.login  {providerId, authType} → {loginId}  (starts ModelRuntime.login)
 *   auth.state  {loginId}               → the current prompt / notify event
 *   auth.answer {loginId, value}        → answer the outstanding prompt
 *
 * until `status` becomes "done" (credential stored) or "error". This is
 * pi's own interaction contract (AuthInteraction: `prompt` returns a string,
 * `notify` delivers info/auth_url/device_code/progress events) bridged to
 * the page — the web renders pi's events and posts pi's answers.
 */
import { randomUUID } from "node:crypto";
import type { PiApiContext, PiApiModule } from "./types.ts";

/** pi's AuthPrompt / AuthEvent / ModelRuntime surface, structural. */
interface AuthPromptLike {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: ReadonlyArray<{ id: string; label: string; description?: string }>;
}
interface AuthEventLike {
  type: "info" | "auth_url" | "device_code" | "progress";
  message?: string;
  links?: ReadonlyArray<{ url: string; label?: string }>;
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
}
interface ProviderAuthLike {
  name?: string;
  isSubscription?: boolean;
  login?: unknown;
}
interface ProviderLike {
  id: string;
  name: string;
  auth: {
    oauth?: ProviderAuthLike;
    apiKey?: ProviderAuthLike;
  };
}
interface CredentialInfoLike {
  providerId: string;
  type: "oauth" | "api_key";
}
interface ModelRuntimeLike {
  getProviders(): readonly ProviderLike[];
  getProviderAuthStatus(providerId: string): { configured: boolean };
  getProvider(providerId: string): ProviderLike | undefined;
  listCredentials(options?: { signal?: AbortSignal }): Promise<readonly CredentialInfoLike[]>;
  login(
    providerId: string,
    type: "oauth" | "api_key",
    interaction: {
      signal?: AbortSignal;
      prompt(prompt: AuthPromptLike): Promise<string>;
      notify(event: AuthEventLike): void;
    },
    options?: { getDeviceId?: () => string },
  ): Promise<unknown>;
  logout(providerId: string, options?: { signal?: AbortSignal }): Promise<void>;
}

let runtimePromise: Promise<ModelRuntimeLike> | null = null;
function getRuntime(): Promise<ModelRuntimeLike> {
  runtimePromise ??= import("@earendil-works/pi-coding-agent").then(({ ModelRuntime }) =>
    ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false }) as Promise<unknown> as Promise<ModelRuntimeLike>,
  );
  return runtimePromise;
}

/** Pending interactive logins, keyed by loginId. */
interface PendingLogin {
  status: "pending" | "done" | "error";
  prompt: AuthPromptLike | null;
  event: AuthEventLike | null;
  error: string | null;
  providerId: string;
  authType: "oauth" | "api_key";
  /** The prompt callback is awaiting this when prompt !== null. */
  resolvePrompt: ((value: string) => void) | null;
  rejectPrompt: ((error: Error) => void) | null;
}

const pendingLogins = new Map<string, PendingLogin>();

function finishPending(pending: PendingLogin, status: "done" | "error", error: string | null): void {
  pending.status = status;
  pending.error = error;
  pending.prompt = null;
  pending.event = null;
  pending.resolvePrompt = null;
  pending.rejectPrompt = null;
}

function listProviders(runtime: ModelRuntimeLike): Array<{ id: string; name: string; authType: "oauth" | "api_key"; configured: boolean }> {
  const out: Array<{ id: string; name: string; authType: "oauth" | "api_key"; configured: boolean }> = [];
  for (const provider of runtime.getProviders()) {
    const configured = runtime.getProviderAuthStatus(provider.id).configured;
    if (provider.auth.oauth !== undefined) {
      out.push({ id: provider.id, name: provider.auth.oauth.name ?? provider.name, authType: "oauth", configured });
    }
    if (provider.auth.apiKey !== undefined) {
      out.push({ id: provider.id, name: provider.auth.apiKey.name ?? provider.name, authType: "api_key", configured });
    }
  }
  return out;
}

/** Start a login flow; returns {loginId} immediately, never blocks. */
async function startLogin(providerId: string, authType: "oauth" | "api_key"): Promise<string> {
  const runtime = await getRuntime();
  const provider = runtime.getProvider(providerId);
  if (provider === undefined) throw new Error(`unknown provider: ${providerId}`);
  const method = authType === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
  if (method === undefined || method.login === undefined) {
    throw new Error(`${provider.name} does not support ${authType} login`);
  }

  const loginId = randomUUID();
  const pending: PendingLogin = {
    status: "pending",
    prompt: null,
    event: null,
    error: null,
    providerId,
    authType,
    resolvePrompt: null,
    rejectPrompt: null,
  };
  pendingLogins.set(loginId, pending);

  const interaction = {
    // A prompt blocks the flow until auth.answer resolves it; the signal
    // ties cancellation to the pending entry being forgotten (dispose).
    prompt: (prompt: AuthPromptLike): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        pending.prompt = prompt;
        pending.resolvePrompt = resolve;
        pending.rejectPrompt = reject;
      }),
    notify: (event: AuthEventLike): void => {
      pending.event = event;
    },
  };

  void runtime
    .login(providerId, authType, interaction)
    .then(() => finishPending(pending, "done", null))
    .catch((error: unknown) => {
      finishPending(pending, "error", error instanceof Error ? error.message : String(error));
    });

  return loginId;
}

/** The wire form of the outstanding prompt (select → options). */
function promptToWire(prompt: AuthPromptLike | null): unknown {
  if (prompt === null) return null;
  return {
    type: prompt.type,
    message: prompt.message,
    ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}),
    ...(prompt.options !== undefined
      ? {
        options: prompt.options.map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.description !== undefined ? { description: option.description } : {}),
        })),
      }
      : {}),
  };
}

function eventToWire(event: AuthEventLike | null): unknown {
  if (event === null) return null;
  return event;
}

export const authReadApi: PiApiModule = {
  api: "auth.read",

  async handle(_params: unknown, _ctx: PiApiContext): Promise<unknown> {
    const runtime = await getRuntime();
    const credentials = await runtime.listCredentials({ signal: AbortSignal.timeout(15_000) });
    return {
      providers: listProviders(runtime),
      credentials: credentials.map((credential) => ({ providerId: credential.providerId, type: credential.type })),
    };
  },
};

export const authLoginApi: PiApiModule = {
  api: "auth.login",

  async handle(params: unknown, _ctx: PiApiContext): Promise<unknown> {
    const { providerId, authType } = (params as { providerId?: unknown; authType?: unknown } | null ?? {}) as {
      providerId?: unknown;
      authType?: unknown;
    };
    if (typeof providerId !== "string" || providerId.trim() === "") {
      throw new Error("params: {providerId: string, authType: 'oauth' | 'api_key'}");
    }
    if (authType !== "oauth" && authType !== "api_key") {
      throw new Error("authType must be 'oauth' or 'api_key'");
    }
    const loginId = await startLogin(providerId.trim(), authType);
    return { loginId };
  },
};

export const authStateApi: PiApiModule = {
  api: "auth.state",

  async handle(params: unknown, _ctx: PiApiContext): Promise<unknown> {
    const { loginId } = (params as { loginId?: unknown } | null ?? {}) as { loginId?: unknown };
    if (typeof loginId !== "string") throw new Error("params: {loginId: string}");
    const pending = pendingLogins.get(loginId);
    if (pending === undefined) return { status: "error", error: "login not found" };
    return {
      status: pending.status,
      ...(pending.status === "error" ? { error: pending.error ?? "login failed" } : {}),
      prompt: promptToWire(pending.status === "pending" ? pending.prompt : null),
      event: eventToWire(pending.status === "pending" ? pending.event : null),
    };
  },
};

export const authAnswerApi: PiApiModule = {
  api: "auth.answer",

  async handle(params: unknown, _ctx: PiApiContext): Promise<unknown> {
    const { loginId, value } = (params as { loginId?: unknown; value?: unknown } | null ?? {}) as {
      loginId?: unknown;
      value?: unknown;
    };
    if (typeof loginId !== "string" || typeof value !== "string") {
      throw new Error("params: {loginId: string, value: string}");
    }
    const pending = pendingLogins.get(loginId);
    if (pending === undefined) throw new Error("login not found");
    if (pending.status !== "pending" || pending.resolvePrompt === null) {
      throw new Error("no prompt awaiting an answer");
    }
    pending.prompt = null;
    pending.resolvePrompt(value);
    pending.resolvePrompt = null;
    pending.rejectPrompt = null;
    return { ok: true };
  },
};

export const authLogoutApi: PiApiModule = {
  api: "auth.logout",

  async handle(params: unknown, _ctx: PiApiContext): Promise<unknown> {
    const { providerId } = (params as { providerId?: unknown } | null ?? {}) as { providerId?: unknown };
    if (typeof providerId !== "string" || providerId.trim() === "") {
      throw new Error("params: {providerId: string}");
    }
    const runtime = await getRuntime();
    await runtime.logout(providerId.trim(), { signal: AbortSignal.timeout(15_000) });
    return { ok: true };
  },
};