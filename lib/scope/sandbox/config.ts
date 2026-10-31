import { resolve } from "node:path";
import { canonicalize, expandHome } from "../paths.ts";

export type SandboxMode = "off" | "workspace" | "readonly";
export type SandboxBackendId = "auto" | "landlock" | "bwrap" | "seatbelt" | "none";
export type SandboxAskMode = "refusal" | "preflight" | "both";
export type SandboxRetryMode = "model" | "auto";
export type SandboxScratch = "session" | "off" | string;

export interface SandboxConfig {
  mode: SandboxMode;
  backend: SandboxBackendId;
  ask: SandboxAskMode;
  retry: SandboxRetryMode;
  scratch: SandboxScratch;
  allow: readonly string[];
  deny: readonly string[];
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  mode: "off",
  backend: "auto",
  ask: "both",
  retry: "model",
  scratch: "session",
  allow: [],
  deny: [],
};

const VALID_MODES: ReadonlySet<string> = new Set(["off", "workspace", "readonly"]);
const VALID_BACKENDS: ReadonlySet<string> = new Set(["auto", "landlock", "bwrap", "seatbelt", "none"]);
const VALID_ASKS: ReadonlySet<string> = new Set(["refusal", "preflight", "both"]);
const VALID_RETRIES: ReadonlySet<string> = new Set(["model", "auto"]);
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "mode",
  "backend",
  "ask",
  "retry",
  "scratch",
  "allow",
  "deny",
]);

function normalizePath(raw: string, base: string): string {
  return canonicalize(resolve(base, expandHome(raw)));
}

/**
 * Parse and validate a `sandbox` configuration block.
 * Unknown keys and invalid values are pushed to `problems` and never silently ignored.
 */
export function parseSandboxConfig(
  raw: unknown,
  file: string,
  base: string,
  problems: string[],
): Partial<SandboxConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    problems.push(`${file}: "sandbox" must be an object`);
    return {};
  }

  const obj = raw as Record<string, unknown>;
  const result: Partial<SandboxConfig> = {};

  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      problems.push(`${file}: unknown key "sandbox.${key}"`);
    }
  }

  if ("mode" in obj) {
    const val = obj.mode;
    if (typeof val === "string" && VALID_MODES.has(val)) {
      result.mode = val as SandboxMode;
    } else {
      problems.push(`${file}: invalid "sandbox.mode" ${JSON.stringify(val)}; expected off, workspace, or readonly`);
    }
  }

  if ("backend" in obj) {
    const val = obj.backend;
    if (typeof val === "string" && VALID_BACKENDS.has(val)) {
      result.backend = val as SandboxBackendId;
    } else {
      problems.push(`${file}: invalid "sandbox.backend" ${JSON.stringify(val)}; expected auto, landlock, bwrap, seatbelt, or none`);
    }
  }

  if ("ask" in obj) {
    const val = obj.ask;
    if (typeof val === "string" && VALID_ASKS.has(val)) {
      result.ask = val as SandboxAskMode;
    } else {
      problems.push(`${file}: invalid "sandbox.ask" ${JSON.stringify(val)}; expected refusal, preflight, or both`);
    }
  }

  if ("retry" in obj) {
    const val = obj.retry;
    if (typeof val === "string" && VALID_RETRIES.has(val)) {
      result.retry = val as SandboxRetryMode;
    } else {
      problems.push(`${file}: invalid "sandbox.retry" ${JSON.stringify(val)}; expected model or auto`);
    }
  }

  if ("scratch" in obj) {
    const val = obj.scratch;
    if (val === "session" || val === "off") {
      result.scratch = val;
    } else if (typeof val === "string" && val.trim()) {
      result.scratch = normalizePath(val.trim(), base);
    } else {
      problems.push(`${file}: invalid "sandbox.scratch" ${JSON.stringify(val)}; expected session, off, or a path`);
    }
  }

  if ("allow" in obj) {
    const val = obj.allow;
    if (Array.isArray(val)) {
      const allowed: string[] = [];
      for (const item of val) {
        if (typeof item === "string" && item.trim()) {
          allowed.push(normalizePath(item.trim(), base));
        } else {
          problems.push(`${file}: "sandbox.allow" entries must be non-empty strings`);
        }
      }
      result.allow = allowed;
    } else {
      problems.push(`${file}: "sandbox.allow" must be an array of paths`);
    }
  }

  if ("deny" in obj) {
    const val = obj.deny;
    if (Array.isArray(val)) {
      const denied: string[] = [];
      for (const item of val) {
        if (typeof item === "string" && item.trim()) {
          denied.push(normalizePath(item.trim(), base));
        } else {
          problems.push(`${file}: "sandbox.deny" entries must be non-empty strings`);
        }
      }
      result.deny = denied;
    } else {
      problems.push(`${file}: "sandbox.deny" must be an array of paths`);
    }
  }

  return result;
}

/**
 * Merge an override configuration onto a base configuration.
 * Scalar options override; allow and deny arrays are unioned and deduplicated.
 */
export function mergeSandboxConfig(
  base: SandboxConfig,
  override?: Partial<SandboxConfig>,
): SandboxConfig {
  if (!override) return { ...base };
  return {
    mode: override.mode ?? base.mode,
    backend: override.backend ?? base.backend,
    ask: override.ask ?? base.ask,
    retry: override.retry ?? base.retry,
    scratch: override.scratch ?? base.scratch,
    allow: override.allow
      ? Array.from(new Set([...base.allow, ...override.allow]))
      : base.allow,
    deny: override.deny
      ? Array.from(new Set([...base.deny, ...override.deny]))
      : base.deny,
  };
}
