/**
 * Startup policy for exposing pi-web beyond loopback.
 *
 * The web API can drive a shell-capable agent, so a public bind without a
 * password is not a configuration mistake the operator should discover from a
 * log line. This module owns that decision as a pure function; the server
 * entry only reads env vars and acts on the refusal.
 */

export type ExposureAuthMode = "disabled" | "enabled" | "invalid";
export type ExposureProxyTrust = "all" | "off" | "loopback";

export interface ExposurePolicyInput {
  /** The address the listener binds to. */
  readonly host: string;
  readonly authMode: ExposureAuthMode;
  readonly trustProxy: ExposureProxyTrust;
  /** Explicit operator opt-outs, normally read from PI_WEB_ALLOW_* env vars. */
  readonly allowUnprotected?: boolean;
  readonly allowTrustAllProxy?: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/**
 * The reason a listener must not start, or null when it is safe to bind.
 * Loopback stays unrestricted: it is the documented local-development mode.
 */
export function webExposureRefusal(input: ExposurePolicyInput): string | null {
  if (isLoopbackHost(input.host)) return null;
  if (input.authMode !== "enabled" && input.allowUnprotected !== true) {
    return `refusing to listen on ${input.host} without password protection: run /web set-password first, or set PI_WEB_ALLOW_UNPROTECTED=1 to accept the risk explicitly`;
  }
  if (input.trustProxy === "all" && input.allowTrustAllProxy !== true) {
    return `refusing PI_WEB_TRUST_PROXY=all on ${input.host}: any client can forge forwarding headers; set PI_WEB_TRUST_PROXY=loopback (or off) and configure your proxy, or set PI_WEB_ALLOW_TRUST_ALL_PROXY=1 to accept the risk explicitly`;
  }
  return null;
}
