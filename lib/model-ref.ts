/**
 * Model references as the web speaks them.
 *
 * A picker click arrives at the bridge as two strings, not as the `Model`
 * object the TUI's selector hands to `setModel`. So the extension has to
 * resolve `provider/id` back to a model — and it must resolve against the
 * same list the picker offered, which is the full catalogue (the picker's
 * "All models" tab), not only the session's scope. Resolving against the
 * scope alone rejected every pick outside it with `model not found`, and the
 * web chip then fell back to the previous model.
 */

/** A model as the web picker names it. */
export interface ModelRef {
  provider: string;
  id: string;
}

/** Drop duplicates, keeping the first occurrence (callers pass scoped first). */
export function uniqueModelRefs(refs: readonly ModelRef[]): ModelRef[] {
  const seen = new Set<string>();
  const unique: ModelRef[] = [];
  for (const ref of refs) {
    const key = `${ref.provider}/${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

/**
 * Resolve a picker term the way the TUI's selector does: an exact
 * `provider/id`, or a bare `id` that is unique across providers. `refs` is
 * everything the picker offered, so a pick outside the session's scope still
 * resolves.
 */
export function findModelRef(refs: readonly ModelRef[], term: string): ModelRef | undefined {
  const pool = uniqueModelRefs(refs);
  const trimmed = term.trim();
  const exact = pool.find((ref) => `${ref.provider}/${ref.id}` === trimmed);
  if (exact !== undefined) return exact;
  const bare = pool.filter((ref) => ref.id === trimmed);
  return bare.length === 1 ? bare[0] : undefined;
}
