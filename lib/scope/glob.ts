/**
 * Rule matching, with opencode's semantics on purpose.
 *
 * `*` matches zero or more characters (including `/`), `?` matches exactly one,
 * everything else is literal. Rules are evaluated **last match wins**, which is
 * why config authors put the catch-all first and exceptions after it. A rule set
 * with no match is not "allow": the caller decides, and the default is `ask`.
 */
import type { ScopeRule, ScopeEffect } from "./types.ts";

const cache = new Map<string, RegExp>();

function compile(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;
  let source = "";
  for (const char of pattern) {
    if (char === "*") source += "[\\s\\S]*";
    else if (char === "?") source += "[\\s\\S]";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  const compiled = new RegExp(`^${source}$`);
  // Bound the cache: rule patterns come from config files, and an unbounded map
  // would grow with every `/scope allow` in a long session.
  if (cache.size > 512) cache.clear();
  cache.set(pattern, compiled);
  return compiled;
}

/** Does `resource` match this rule's resource glob? */
export function globMatch(pattern: string, resource: string): boolean {
  if (pattern === "*" || pattern === resource) return true;
  if (compile(pattern).test(resource)) return true;
  // opencode's rule for shell patterns: one ending in ` *` also matches the
  // command without arguments, so a saved `git status *` covers a bare
  // `git status`. Without it a command grant would silently miss the short form.
  return pattern.endsWith(" *") && compile(pattern.slice(0, -2)).test(resource);
}

export interface RuleMatch {
  rule: ScopeRule;
  effect: ScopeEffect;
}

/** Last matching rule wins; `undefined` when nothing matches. */
export function resolveRule(
  rules: readonly ScopeRule[],
  action: string,
  resource: string,
  matcher: (pattern: string, value: string) => boolean = globMatch,
): RuleMatch | undefined {
  let found: RuleMatch | undefined;
  for (const rule of rules) {
    if (!matcher(rule.action, action) && rule.action !== "*") continue;
    if (!matcher(rule.resource, resource)) continue;
    found = { rule, effect: rule.effect };
  }
  return found;
}
