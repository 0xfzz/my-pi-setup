/**
 * Minimal semver: strict `x.y.z[-pre]` versions and the range subset the
 * plugin manifest accepts (`*`, `=`, bare, `>`, `>=`, `<`, `<=`, `^`, `~`,
 * comma/space AND, `||` OR). Kept dependency-free on purpose; the grammar is
 * the contract, so widening it is a deliberate change with a test.
 */

export interface SemVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
const PARTIAL_RE = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*|x|\*))?(?:\.(0|[1-9]\d*|x|\*))?$/;

export function parseVersion(input: string): SemVersion | undefined {
  const match = VERSION_RE.exec(input);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifier(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Number(a) - Number(b);
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a: SemVersion, b: SemVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  // A prerelease sorts before the release it precedes.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.prerelease.length) return -1;
    if (i >= b.prerelease.length) return 1;
    const diff = compareIdentifier(a.prerelease[i], b.prerelease[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

type Comparator = (v: SemVersion) => boolean;

/** Lower-bound triple for a partial version (`1` -> 1.0.0, `1.2` -> 1.2.0). */
function bound(partial: string): { version: SemVersion; parts: number } | undefined {
  const match = PARTIAL_RE.exec(partial);
  if (!match) return undefined;
  const parts = [match[1], match[2], match[3]];
  const given = parts.filter((p) => p !== undefined && p !== "x" && p !== "*").length;
  return {
    version: {
      major: Number(parts[0]),
      minor: parts[1] === undefined || parts[1] === "x" || parts[1] === "*" ? 0 : Number(parts[1]),
      patch: parts[2] === undefined || parts[2] === "x" || parts[2] === "*" ? 0 : Number(parts[2]),
      prerelease: [],
    },
    parts: given,
  };
}

function caret(partial: string): Comparator | undefined {
  const b = bound(partial);
  if (!b) return undefined;
  const { version: lo, parts } = b;
  const hi: SemVersion = lo.major > 0 || parts === 1
    ? { major: lo.major + 1, minor: 0, patch: 0, prerelease: [] }
    : lo.minor > 0 || parts === 2
      ? { major: 0, minor: lo.minor + 1, patch: 0, prerelease: [] }
      : { major: 0, minor: 0, patch: lo.patch + 1, prerelease: [] };
  return (v) => compareVersions(v, lo) >= 0 && compareVersions(v, hi) < 0;
}

function tilde(partial: string): Comparator | undefined {
  const b = bound(partial);
  if (!b) return undefined;
  const { version: lo, parts } = b;
  const hi: SemVersion = parts === 1
    ? { major: lo.major + 1, minor: 0, patch: 0, prerelease: [] }
    : { major: lo.major, minor: lo.minor + 1, patch: 0, prerelease: [] };
  return (v) => compareVersions(v, lo) >= 0 && compareVersions(v, hi) < 0;
}

function comparator(token: string): Comparator | undefined {
  if (token === "*" || token === "x" || token === "") return () => true;
  if (token.startsWith("^")) return caret(token.slice(1));
  if (token.startsWith("~")) return tilde(token.slice(1));
  const op = /^(>=|<=|>|<|=)?(.+)$/.exec(token);
  if (!op) return undefined;
  const target = parseVersion(op[2]);
  if (!target) return undefined;
  switch (op[1]) {
    case ">=": return (v) => compareVersions(v, target) >= 0;
    case "<=": return (v) => compareVersions(v, target) <= 0;
    case ">": return (v) => compareVersions(v, target) > 0;
    case "<": return (v) => compareVersions(v, target) < 0;
    default: return (v) => compareVersions(v, target) === 0;
  }
}

/** Compile a range into a predicate, or `undefined` when the syntax is invalid. */
export function compileRange(range: string): ((v: SemVersion) => boolean) | undefined {
  const alternatives: Comparator[][] = [];
  for (const branch of range.split("||")) {
    const tokens = branch.trim().split(/[\s,]+/).filter(Boolean);
    if (tokens.length === 0) return undefined;
    const compiled: Comparator[] = [];
    for (const token of tokens) {
      const c = comparator(token);
      if (!c) return undefined;
      compiled.push(c);
    }
    alternatives.push(compiled);
  }
  if (alternatives.length === 0) return undefined;
  return (v) => alternatives.some((all) => all.every((c) => c(v)));
}

export function isValidRange(range: string): boolean {
  return compileRange(range) !== undefined;
}

/** True when `version` (a string) satisfies `range`. Invalid inputs never satisfy. */
export function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  const test = compileRange(range);
  return parsed !== undefined && test !== undefined && test(parsed);
}
