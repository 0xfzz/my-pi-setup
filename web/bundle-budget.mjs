/**
 * Build-time budget assertion. The ceilings themselves are registered in the
 * single web config; this module only enforces them.
 */
import { registry } from "./load-registry.mjs";

export const INITIAL_BUNDLE_BUDGETS = registry.INITIAL_BUNDLE_BUDGETS;

export function assertBundleWithinBudget(name, bytes, budgets = INITIAL_BUNDLE_BUDGETS) {
  const limit = budgets[name];
  if (limit === undefined) throw new Error(`no bundle budget declared for ${name}`);
  if (bytes > limit) {
    throw new Error(`${name} is ${bytes} bytes, over its ${limit}-byte budget`);
  }
}
