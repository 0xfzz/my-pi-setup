import test from "node:test";
import assert from "node:assert/strict";
import {
  isLoopbackHost,
  webExposureRefusal,
  type ExposureAuthMode,
  type ExposureProxyTrust,
} from "../lib/web-exposure-policy.ts";

function refusal(
  host: string,
  authMode: ExposureAuthMode,
  trustProxy: ExposureProxyTrust = "loopback",
  overrides: { allowUnprotected?: boolean; allowTrustAllProxy?: boolean } = {},
): string | null {
  return webExposureRefusal({ host, authMode, trustProxy, ...overrides });
}

test("loopback binds stay unrestricted in every auth mode", () => {
  for (const host of ["127.0.0.1", "::1", "localhost", " ::ffff:127.0.0.1 "]) {
    assert.equal(isLoopbackHost(host), true, host);
    for (const mode of ["disabled", "enabled", "invalid"] as const) {
      assert.equal(refusal(host, mode, "all"), null, `${host} ${mode}`);
    }
  }
});

test("a public bind without a password is refused", () => {
  for (const mode of ["disabled", "invalid"] as const) {
    const reason = refusal("0.0.0.0", mode);
    assert.match(reason ?? "", /set-password/);
    assert.match(reason ?? "", /PI_WEB_ALLOW_UNPROTECTED=1/);
  }
});

test("an explicit override permits an unprotected public bind", () => {
  assert.equal(refusal("0.0.0.0", "disabled", "loopback", { allowUnprotected: true }), null);
});

test("a password alone permits a public bind with a safe proxy policy", () => {
  for (const trust of ["off", "loopback"] as const) {
    assert.equal(refusal("0.0.0.0", "enabled", trust), null);
  }
});

test("trusting every proxy on a public bind is refused", () => {
  const reason = refusal("0.0.0.0", "enabled", "all");
  assert.match(reason ?? "", /PI_WEB_TRUST_PROXY=all/);
  assert.match(reason ?? "", /PI_WEB_ALLOW_TRUST_ALL_PROXY=1/);
  assert.equal(refusal("0.0.0.0", "enabled", "all", { allowTrustAllProxy: true }), null);
});
