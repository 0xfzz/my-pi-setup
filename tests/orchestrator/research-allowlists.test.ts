import test from "node:test";
import assert from "node:assert/strict";

import { SPEC_ONLY_TOOLS, isSpecOnlyDeniedTool } from "../../lib/orchestrator/review-policy.ts";
import { SUPERVISOR_TOOLS } from "../../lib/supervise-mode.ts";

// RESEARCH_TOOLS is module-private by design; the child allowlist is asserted
// through `childToolsForPurpose`, which is the only supported accessor.
import { childToolsForPurpose } from "../../lib/spawn-policy.ts";

const RESEARCH_TOOLS = (childToolsForPurpose("research") ?? "").split(",");

const RESEARCH_SURFACE = ["code_map", "code_search", "code_read", "web_read", "web_research", "web_fetch", "shell_read"];

test("a spec reviewer may research the web and the codebase read-only", () => {
  for (const name of RESEARCH_SURFACE) {
    assert.ok(SPEC_ONLY_TOOLS.has(name), `reviewer should have ${name}`);
    assert.equal(isSpecOnlyDeniedTool(name), false, `${name} must not be denied`);
  }
});

test("a spec reviewer may write only scoped evidence artifacts", () => {
  for (const name of ["artifact_save", "artifact_edit", "artifact_recall"]) {
    assert.ok(SPEC_ONLY_TOOLS.has(name), `reviewer should have ${name}`);
    assert.equal(isSpecOnlyDeniedTool(name), false);
  }
  for (const name of ["artifact_search", "artifact_list"]) {
    assert.equal(isSpecOnlyDeniedTool(name), true, `${name} would leak other scopes`);
  }
});

test("the work tree still has no writer in the reviewer surface", () => {
  for (const name of ["write", "edit", "apply_patch", "bash", "browser", "mcp", "codemode", "generate_image"]) {
    assert.equal(isSpecOnlyDeniedTool(name), true, `${name} must stay denied`);
  }
});

test("a research child gets the same read-only surface plus scoped evidence", () => {
  for (const name of [...RESEARCH_SURFACE, "artifact_save", "artifact_edit", "artifact_recall"]) {
    assert.ok(RESEARCH_TOOLS.includes(name), `research child should have ${name}`);
  }
  for (const name of ["artifact_search", "artifact_list", "write", "edit"]) {
    assert.equal(RESEARCH_TOOLS.includes(name), false, `research child must not have ${name}`);
  }
});

test("the orchestrator parent gets the research surface and keeps its artifacts", () => {
  for (const name of [...RESEARCH_SURFACE, "artifact_save", "artifact_edit", "artifact_search", "artifact_list"]) {
    assert.ok(SUPERVISOR_TOOLS.has(name), `parent should have ${name}`);
  }
  for (const name of ["write", "edit"]) {
    assert.equal(SUPERVISOR_TOOLS.has(name), false, "the parent still does not implement");
  }
});
