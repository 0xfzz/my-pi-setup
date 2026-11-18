/**
 * Build-time ceilings for the JavaScript fetched on a cold page load.
 *
 * The browser pays for all three bytes, parse and execution; a later import of
 * an optional bundle (icons, document renderers, mermaid) is not on this path.
 * A build fails loudly when a dependency drifts back into an entry point.
 */
export const INITIAL_BUNDLE_BUDGETS = Object.freeze({
  "app.js": 850_000,
  "runtime.js": 500_000,
  "ui.js": 650_000,
});

export function assertBundleWithinBudget(name, bytes, budgets = INITIAL_BUNDLE_BUDGETS) {
  const limit = budgets[name];
  if (limit === undefined) throw new Error(`no bundle budget declared for ${name}`);
  if (bytes > limit) {
    throw new Error(`${name} is ${bytes} bytes, over its ${limit}-byte budget`);
  }
}
