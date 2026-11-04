/**
 * lint-staged config. Lives in a JS file because the command filters vendored
 * files before invoking oxlint (see scripts/lint-staged-oxlint.mjs): a string
 * command in package.json cannot skip the run when every staged file is
 * vendored, and oxlint refuses an all-excluded file set.
 */
export default {
  "*.{ts,tsx,js,mjs}": (files) => `node scripts/lint-staged-oxlint.mjs ${files.map((f) => `"${f}"`).join(" ")}`,
};
