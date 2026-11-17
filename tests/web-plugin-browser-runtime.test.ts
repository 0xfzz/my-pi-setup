import test from "node:test";
import assert from "node:assert/strict";

import { AuditLog } from "../web/core/plugin-contracts/kernel/audit.ts";
import {
  BROWSER_MAX_BREAKER,
  browserAllowedInSafeMode,
  browserFailureDecision,
  browserGrantDecision,
  browserRegistrationRefusal,
  confirmBrowserGrant,
} from "../web/core/protocol/browser-runtime.ts";

const grant = confirmBrowserGrant({ id: "acme.zen", version: "1.0.0", hash: "sha256:aaa", sourcePath: "./browser/main.tsx", capabilities: ["ui.publish"], now: 10 });

test("a browser half needs a trusted manifest and an operator grant", () => {
  const base = { id: "acme.zen", version: "1.0.0", hash: "sha256:aaa", sourcePath: "./browser/main.tsx", now: 11 };
  assert.equal(browserGrantDecision({ ...base, trust: "declarative", grant }).kind, "revoke");
  assert.equal(browserGrantDecision({ ...base, trust: "trusted", grant: undefined }).kind, "confirm");
  assert.equal(browserGrantDecision({ ...base, trust: "trusted", grant }).kind, "load");
  assert.deepEqual(grant.capabilities, ["ui.publish"]);
});

test("a changed hash or version revokes the grant", () => {
  const base = { id: "acme.zen", version: "1.0.0", trust: "trusted" as const, sourcePath: "./browser/main.tsx", now: 12 };
  const hashChange = browserGrantDecision({ ...base, hash: "sha256:bbb", grant });
  assert.equal(hashChange.kind, "revoke");
  if (hashChange.kind === "revoke") assert.match(hashChange.reason, /hash changed/);
  const versionChange = browserGrantDecision({ ...base, hash: "sha256:aaa", version: "2.0.0", grant });
  assert.equal(versionChange.kind, "revoke");
});

test("protected core points cannot be replaced by a browser half", () => {
  for (const point of ["core.auth.session", "core.transport", "core.plugin-manager", "core.capability-gate", "core.confirm.destructive"]) {
    assert.match(browserRegistrationRefusal(point) ?? "", /protected core/);
  }
  assert.equal(browserRegistrationRefusal("ui.replace:chat.composer"), undefined);
});

test("safe mode loads core plugins only", () => {
  assert.equal(browserAllowedInSafeMode(true, false), false);
  assert.equal(browserAllowedInSafeMode(true, true), true);
  assert.equal(browserAllowedInSafeMode(false, false), true);
});

test("a render failure restores the built-in, then quarantines at the breaker limit", () => {
  assert.equal(browserFailureDecision(0), "restore");
  assert.equal(browserFailureDecision(BROWSER_MAX_BREAKER - 1), "quarantine");
});

test("browser grant decisions are auditable with named kinds", () => {
  const log = new AuditLog({ clock: () => 42 });
  log.append("browser-granted", "acme.zen", "hash sha256:aaa confirmed");
  log.append("browser-revoked", "acme.zen", "hash sha256:bbb changed");
  assert.deepEqual(log.list().map((entry) => entry.kind), ["browser-granted", "browser-revoked"]);
});
