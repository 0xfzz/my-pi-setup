import assert from "node:assert/strict";
import test from "node:test";
import { uiDiagnosticsEnabled } from "./web-ui-diagnostics-policy.ts";

test("UI diagnostics are disabled in production unless explicitly enabled", () => {
  assert.equal(uiDiagnosticsEnabled({ NODE_ENV: "production" }), false);
  assert.equal(uiDiagnosticsEnabled({ NODE_ENV: "production", PI_WEB_UI_DIAGNOSTICS: "true" }), false);
  assert.equal(uiDiagnosticsEnabled({ NODE_ENV: "production", PI_WEB_UI_DIAGNOSTICS: "1" }), true);
  assert.equal(uiDiagnosticsEnabled({ NODE_ENV: "development" }), true);
  assert.equal(uiDiagnosticsEnabled({ NODE_ENV: "test" }), true);
});
