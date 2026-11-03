// Keep router virtual models inside Pi's scoped model list.
//
// Pi cycles (Ctrl+P) and lists (`/model`) only the models matched by the
// `enabledModels` setting once it is non-empty. A router route is registered in
// the catalog but matches none of the user's patterns, so it is invisible in
// exactly the setups that curate their list. Adding `<provider>/*` to the
// global setting makes every current and future route show up.
//
// Only the one key is rewritten, on the raw document, so unknown settings and
// the user's own ordering survive. Pi persists just the fields it modifies, so
// the write does not fight the running settings manager.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Whether a pattern already makes `<provider>/<id>` part of the scope. */
export function scopeCoversProvider(patterns: readonly string[], provider: string): boolean {
  const prefix = `${provider.toLowerCase()}/`;
  return patterns.some((pattern) => {
    const text = pattern.toLowerCase().replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
    return text === `${prefix}*` || text === "*";
  });
}

/**
 * Append `<provider>/*` to the `enabledModels` of a settings file.
 *
 * Returns true only when the file changed. An absent or empty list means "all
 * models" and is left alone, as is a file that is not a JSON object.
 */
export function ensureProviderInScope(settingsPath: string, provider: string): boolean {
  if (!existsSync(settingsPath)) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return false;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const doc = raw as Record<string, unknown>;
  const list = doc.enabledModels;
  if (!Array.isArray(list) || list.length === 0 || !list.every((entry) => typeof entry === "string")) return false;
  if (scopeCoversProvider(list as string[], provider)) return false;
  doc.enabledModels = [...list, `${provider}/*`];
  const temp = `${settingsPath}.router-${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, settingsPath);
  return true;
}
