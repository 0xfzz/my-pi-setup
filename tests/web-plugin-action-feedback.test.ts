import test from "node:test";
import assert from "node:assert/strict";
import { actionFailureMessage, NO_RESPONSE_MESSAGE } from "../web/core/client/plugin-system/actionClient.ts";

/**
 * A plugin action that does not take effect must say why.
 *
 * The failure this covers is silence: a session running an older extension
 * build relays the action (200, `relayed: true`) and then publishes nothing,
 * so the click looks broken rather than stale.
 */

test("a missing plugin names the inactive plugin and points at a new session", () => {
  const message = actionFailureMessage(404, { ok: false, error: "Plugin not found" });
  assert.match(message, /not active in this session/);
  assert.match(message, /Start a new session/);
  assert.match(message, /safe mode/);
});

test("host refusals map to the action the user can take", () => {
  assert.match(actionFailureMessage(403, { ok: false }), /confirmation did not match/);
  assert.match(actionFailureMessage(409, { ok: false }), /still running/);
});

test("a server-supplied reason wins over the generic fallback", () => {
  assert.equal(actionFailureMessage(400, { ok: false, error: "Field value is too long" }), "Field value is too long");
  assert.equal(actionFailureMessage(400, { ok: false, error: "" }), "The action failed.");
  assert.equal(actionFailureMessage(500, {}), "The action failed.");
});

test("the no-reply message points at the stale session, not the plugin", () => {
  assert.match(NO_RESPONSE_MESSAGE, /older build/);
  assert.match(NO_RESPONSE_MESSAGE, /start a new session/i);
});
