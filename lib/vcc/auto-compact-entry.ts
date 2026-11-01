/**
 * Deployed entry point for VCC auto-compaction.
 *
 * This file is mirrored to `~/.pi/agent/extensions/auto-compact.ts` (alongside
 * the rest of `lib/vcc/*`) by `scripts/sync-vcc-auto-compact.mjs`. It is
 * intentionally the only live instance: do not also add it to the package's
 * `pi.extensions`, or Pi would register two compaction controllers.
 *
 * It lives in `lib/vcc/` with the policy it wires up, rather than in a
 * single-file top-level `vcc/` directory.
 *
 * Resolution notes: paths are written for the DEPLOYED location, not this one.
 *   - `../npm/node_modules/pi-vcc/...` resolves from the agent extensions
 *     directory (`~/.pi/agent/extensions`), where Pi installs npm packages.
 *   - `./controller.ts` and its siblings resolve to
 *     `~/.pi/agent/extensions/lib/vcc/*`, which is where the sync script puts
 *     them. In this repository the same specifiers resolve normally, because
 *     this file now sits beside them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compile } from "../npm/node_modules/pi-vcc/src/core/summarize.ts";
import { RECALL_NOTE } from "../npm/node_modules/pi-vcc/src/core/format.ts";
import {
  loadConfig,
  registerAutoCompact as register,
  registerBudgetCommand,
  type AutoCompactConfig,
  type CompileSummary,
} from "./controller.ts";

export { hasCompleteToolPairs, loadConfig, planCompaction } from "./controller.ts";

/**
 * Dependency injection keeps the boundary logic testable without the installed
 * pi-vcc package.
 */
export function registerAutoCompact(
  pi: ExtensionAPI,
  readConfig: () => AutoCompactConfig = loadConfig,
  compileSummary: CompileSummary = compile as unknown as CompileSummary,
) {
  register(pi, { readConfig, compileSummary, recallNote: RECALL_NOTE });
  registerBudgetCommand(pi, { readConfig });
}

export default function autoCompactExtension(pi: ExtensionAPI) {
  registerAutoCompact(pi);
}
