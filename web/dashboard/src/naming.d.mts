/**
 * Type declarations for the shared naming authority. The canonical module is
 * `naming.mjs` (pure, no DOM/Node); this file lets TypeScript callers
 * (`lib/dashboard/projection.ts`, `extensions/orchestrator.ts`) import it.
 */

export interface NamesSource {
  readonly url: string;
  readonly retrieved: string;
  readonly license: string;
  readonly count: number;
}

export declare const NAMES_SOURCE: NamesSource;
export declare const JAVANESE_GIVEN_NAMES: readonly string[];

export interface NameableEntity {
  id?: string;
  name?: string;
  scope?: string;
  purpose?: string;
  kind?: string;
  title?: string;
  project?: string;
  givenName?: string;
}

export interface DisplayNameOptions {
  givenName?: string;
  max?: number;
  usedNames?: Set<string>;
}

export declare function fnv1a(text: unknown): number;
export declare function humanizeSlug(slug: unknown): string;
export declare function isHumanName(value: unknown): boolean;
export declare function splitComposedName(value: unknown): { given: string; role: string } | null;
export declare function givenNamePart(value: unknown): string;
export declare function titleCase(value: unknown): string;
export declare function meaningfulSessionTitle(value: unknown, input?: { project?: string }): string;
export declare function sessionTitle(input?: { project?: string; sessionName?: string; goalTitle?: string }): string;
export declare function managerName(input?: { project?: string; sessionName?: string; goalTitle?: string }): string;
export declare function roleFor(input?: { purpose?: string; scope?: string }): string;
export declare function givenNameFor(id: unknown, usedNames?: Set<string> | Iterable<string>): string;
export declare function assignGivenNames(
  entities?: ReadonlyArray<string | { id: string; name?: string }>,
): Map<string, string>;
export declare function clampLabel(value: unknown, max?: number): string;
export declare function handoffDisplayName(input?: { scope?: string; id?: string }): string;
export declare function displayName(node?: NameableEntity, options?: DisplayNameOptions): string;
export declare function namesDigest(): string;
export declare const ROLE_LABELS: Readonly<Record<"builder" | "implementer" | "reviewer" | "verifier" | "researcher" | "worker", string>>;
export declare const __naming: Readonly<{
  NAME_COUNT: number;
  ACRONYMS: ReadonlySet<string>;
  GENERIC_PREFIXES: ReadonlySet<string>;
  NAME_DIGEST: string;
}>;
