import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { AuditLog } from "../web/core/plugin-contracts/kernel/audit.ts";
import { defaultState, recordBoot } from "../web/core/plugin-contracts/kernel/state.ts";
import {
  BROWSER_MAX_BREAKER,
  browserAllowedInSafeMode,
  browserFailureDecision,
  browserGrantDecision,
  browserRegistrationRefusal,
  browserExtensionPointRefusal,
  browserGrantPromptText,
  browserGrantUpdate,
  browserMountRefusal,
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

test("the env flag and the crash-loop trigger both gate browser halves", () => {
  const explicit = recordBoot(defaultState(), 1, { PI_WEB_SAFE_MODE: "1" }, 101);
  assert.equal(explicit.safeMode, true);
  assert.equal(browserAllowedInSafeMode(explicit.safeMode, false), false);
  const first = recordBoot(defaultState(), 1, {}, 102);
  const second = recordBoot(first.state, 2, {}, 103);
  assert.equal(second.safeMode, true);
  assert.equal(browserAllowedInSafeMode(second.safeMode, false), false);
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

test("grant updates persist the confirmed hash and append a matching audit line", () => {
  const base = { id: "acme.zen", sourcePath: "./browser/main.tsx", capabilities: ["ui.view"] };
  const first = browserGrantUpdate({}, {
    kind: "confirm",
    id: base.id,
    info: { ...base, version: "1.0.0", hash: "sha256:aaa" },
  }, 10);
  assert.equal(first.grants["acme.zen"]?.hash, "sha256:aaa");
  assert.equal(first.audit?.kind, "browser-granted");
  assert.match(first.audit?.detail ?? "", /1\.0\.0/);

  const changed = browserGrantUpdate(first.grants, {
    kind: "revoke",
    id: base.id,
    reason: "browser module hash changed",
  }, 11);
  assert.equal(changed.grants["acme.zen"], undefined);
  assert.equal(changed.audit?.kind, "browser-revoked");
  assert.match(changed.audit?.detail ?? "", /hash changed/);
});

test("the confirmation prompt names id, version, path, hash and capabilities", () => {
  const text = browserGrantPromptText({
    id: "acme.zen",
    version: "2.1.0",
    sourcePath: "./browser/main.tsx",
    hash: "sha256:deadbeef",
    capabilities: ["ui.view", "commands"],
  });
  for (const part of ["acme.zen", "2.1.0", "./browser/main.tsx", "sha256:deadbeef", "ui.view, commands"]) {
    assert.ok(text.includes(part), `${part} must be visible to the operator`);
  }
});

test("mount refusal covers disabled, quarantined and failed-load halves", () => {
  const base = { point: "ui.component.replace" };
  assert.match(browserMountRefusal({ ...base, disabled: true }) ?? "", /disabled/);
  assert.match(browserMountRefusal({ ...base, quarantined: true }) ?? "", /quarantined/);
  assert.match(browserMountRefusal({ ...base, failedLoad: true }) ?? "", /failed to load/);
  assert.equal(browserMountRefusal(base), undefined);
});

test("web/core has no plugin-specific fixture, component or id branch", () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|css)$/.test(entry.name)) {
        const text = readFileSync(path, "utf8");
        for (const needle of ["fixture.e2e", "fixture-composer", "web-bridge-views"]) {
          if (text.includes(needle)) offenders.push(`${path}: ${needle}`);
        }
      }
    }
  };
  walk(join(process.cwd(), "web", "core"));
  assert.deepEqual(offenders, []);
});

test("extension-point registration refuses protected and unknown points", () => {
  assert.match(browserExtensionPointRefusal("core.plugin-manager") ?? "", /protected core/);
  assert.match(browserExtensionPointRefusal("core.mystery") ?? "", /unknown extension point/);
  assert.equal(browserExtensionPointRefusal("ui.component.replace"), undefined);
});
