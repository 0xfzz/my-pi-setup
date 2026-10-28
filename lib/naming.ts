/**
 * Human naming for dashboard and orchestrator entities — the Node/TS authority.
 *
 * The browser dashboard has its own copy at `web/dashboard/src/naming.mjs`.
 * Pi's extension loader cannot reliably import that ESM file: it hands back a
 * module object without the named exports, which crashed `/reload` with
 * `meaningfulSessionTitle is not a function`. A duplicated 300-line pure module
 * is a smaller cost than a dashboard that cannot start.
 *
 * `tests/naming-parity.test.ts` runs both implementations over the same fixture
 * set, so they cannot drift silently. Pure: no DOM, no I/O, no Node APIs.
 *
 * Rules (see web/dashboard/NAMES.md):
 *  - a worker's given name is a pure function of its stable id, hashed into the
 *    vendored Javanese dictionary and probed past names already claimed;
 *  - ids are processed in sorted order, so the same set of children always
 *    produces the same assignment;
 *  - an explicit, human-looking author name always wins;
 *  - the orchestrator reads `{Project} Manager`, never a dictionary name.
 */

const JAVANESE_GIVEN_NAMES: readonly string[] = Object.freeze([
  "Abimanyu", "Abyantara", "Ade", "Adi", "Adianto", "Adijaya", "Adinata", "Adit", "Aditya",
  "Adrianto", "Adriyanto", "Agung", "Agus", "Aji", "Ajiyanto", "Aman", "Andi", "Anggoro",
  "Arga", "Arianto", "Arya", "Atmojo", "Bagaskoro", "Bagio", "Bambang", "Baskoro", "Basuki",
  "Bima", "Bimo", "Broto", "Budianto", "Budiono", "Cahyadi", "Cahyo", "Cahyono", "Candra",
  "Damar", "Damin", "Damono", "Darminto", "Darmono", "Darto", "Daryatmo", "Dewo", "Dibyo",
  "Dimas", "Dwi", "Edi", "Eko", "Gatot", "Gumelar", "Gunawan", "Guntur", "Hadiharjono",
  "Handoko", "Handoyono", "Harhono", "Haris", "Harjo", "Harjono", "Harsoyo", "Hartono", "Haryanto",
  "Haryono", "Hedianto", "Hendro", "Hendroto", "Hermanto", "Hermono", "Indra", "Irawan", "Iswanto",
  "Jarot", "Jenar", "Joko", "Karyono", "Kastono", "Kunto", "Kuntoro", "Kustanto", "Kustono",
  "Kusumo", "Kuswandono", "Kusworo", "Kusyadi", "Legimin", "Lesmana", "Lukmanto", "Lukminto", "Madiyono",
  "Mardiyanto", "Martaja", "Maryono", "Mugiarto", "Mulyoto", "Murdianto", "Muryono", "Ngadimin", "Ngadiran",
  "Ngadirin", "Ngasiran", "Ngatmo", "Ngatmono", "Nugroho", "Paidi", "Paijan", "Paijo", "Paimin",
  "Paino", "Parto", "Paryono", "Ponijan", "Poniman", "Ponimin", "Pramono", "Pranyoto", "Prasetyo",
  "Pratama", "Pratikno", "Pratikto", "Pratomo", "Prayitno", "Priyanto", "Priyo", "Priyono", "Pujianto",
  "Pujiantoro", "Purbo", "Purnomo", "Purwanto", "Purwoto", "Puspoyo", "Putranto", "Rahardian", "Raharjo",
  "Rahayu", "Rangga", "Respati", "Rio", "Riyanto", "Samijan", "Sanyoko", "Sanyono", "Sanyoto",
  "Sarhono", "Sarimin", "Sarlito", "Sartono", "Sarwono", "Seno", "Setiono", "Sigit", "Singgih",
  "Siswanto", "Siswantoyo", "Subadi", "Subroto", "Sucipto", "Sudarsono", "Sudaryanto", "Sudibyo", "Sudono",
  "Sugeng", "Sugiyanto", "Sugiyono", "Suhariyanto", "Suharto", "Suharyanto", "Sujadi", "Sujiman", "Sujoyo",
  "Sukanto", "Sukarman", "Sukarmin", "Sukarno", "Sukartono", "Sukasno", "Sukiman", "Sukirnanto", "Sukirno",
  "Sukurno", "Sulistyo", "Sumadi", "Sumanto", "Sumardi", "Sumarjono", "Sumarno", "Sumartanto", "Sumartono",
  "Sumarwoto", "Sumaryono", "Sunarjo", "Sunarman", "Sunarmin", "Sunarmo", "Sunarso", "Sunarsoyo", "Sunarto",
  "Sunaryadi", "Sunaryo", "Suntono", "Supomo", "Suprapto", "Supriadi", "Suprianto", "Supriyanto", "Supriyo",
  "Supriyono", "Suprono", "Surono", "Suroso", "Suroto", "Suryo", "Suryodarmo", "Susanto", "Susetyo",
  "Suswantono", "Suswantoyo", "Sutarto", "Sutopo", "Sutrisno", "Suwanto", "Suwantono", "Suwardi", "Suwito",
  "Suyanto", "Suyarto", "Suyono", "Tariman", "Tarimin", "Taruno", "Tasiman", "Tasimin", "Tri",
  "Trisno", "Tukijan", "Tukiman", "Tukimin", "Tukiran", "Tukirin", "Tukiyo", "Tusiman", "Tusimin",
  "Wagiman", "Wagimin", "Wagiyo", "Wahono", "Wahyono", "Wahyu", "Wakijan", "Wakijo", "Wakino",
  "Waluyo", "Waluyono", "Wardoyo", "Warno", "Warsito", "Warto", "Waskito", "Wibowo", "Wicaksono",
  "Widianto", "Widodo", "Wijanarko", "Wijaya", "Wijoyo", "Winardi", "Winarjo", "Winarno", "Winarso",
  "Winarto", "Windarto", "Wirawan", "Wiryanto", "Wuryanto", "Yanto", "Yudhoyono", "Yulianto",
]);

const NAME_COUNT = JAVANESE_GIVEN_NAMES.length;

/** Vocabulary that keeps its acronym casing when a slug is humanized. */
const ACRONYMS = new Set([
  "api", "apis", "ui", "ux", "cli", "css", "html", "http", "https", "json", "yaml", "toml",
  "sql", "db", "sse", "ws", "jwt", "oauth", "mcp", "sdk", "sla", "ci", "cd", "pr", "prs",
  "id", "ids", "url", "urls", "uri", "js", "ts", "wasm", "cpu", "gpu", "tui", "dom", "svg",
  "png", "pdf", "csv", "e2e", "qa", "llm", "ai", "ml", "os", "aws", "gcp", "rpc", "grpc",
  "sqlite", "smtp", "tls", "ssl", "dns", "tcp", "udp", "ipc",
]);

/** Leading generic container words that do not describe what the unit builds. */
const GENERIC_PREFIXES = new Set(["repo", "repos", "repository", "project", "src", "lib", "app"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;

const NON_NAMES = new Set([
  "unknown", "tmp", "temp", "home", "null", "undefined", "none", "session", "sessions",
  "default", "root", "user", "admin", "work", "worker", "child", "id", "na", "n/a",
]);

export const ROLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  builder: "Builder",
  implementer: "Implementer",
  reviewer: "Reviewer",
  verifier: "Verifier",
  researcher: "Researcher",
  worker: "Worker",
});

const PURPOSE_ROLES: ReadonlyArray<readonly [RegExp, string]> = [
  [/review|audit|critique/, "reviewer"],
  [/verif|validat|hardening|test|qa\b/, "verifier"],
  [/research|spike|explore|investigat|study/, "researcher"],
  [/implement|build|feature|fix/, "builder"],
];

const SCOPE_ROLES: ReadonlyArray<readonly [RegExp, string]> = [
  [/review|audit|critique/, "reviewer"],
  [/verif|validat|hardening|e2e|qa\b/, "verifier"],
  [/research|spike|explore|investigat/, "researcher"],
  [/impl|implementation/, "implementer"],
  [/build|feature|fix|refactor/, "builder"],
];

/** FNV-1a, 32-bit. Cheap, dependency-free and stable across engines. */
export function fnv1a(text: unknown): number {
  let hash = 0x811c9dc5;
  const value = String(text ?? "");
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function tokensOf(value: unknown): string[] {
  return String(value ?? "")
    .trim()
    .split(/[-_.\s/]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

function titleToken(token: string): string {
  if (!token) return "";
  if (/^[0-9]+$/.test(token)) return token;
  if (token === token.toUpperCase() && token.length <= 4 && /[a-z]/i.test(token)) return token;
  if (ACRONYMS.has(token)) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * `repo-skeleton` → `Repo Skeleton`, `api-go` → `API Go`, `web_core` → `Web Core`.
 * Keeps every token: a handoff label must name the scope exactly.
 */
export function humanizeSlug(slug: unknown): string {
  return tokensOf(slug).map(titleToken).join(" ");
}

/** The subject of a worker's role noun: `repo-skeleton` → `Skeleton Builder`. */
function roleSubject(scope: unknown): string {
  let tokens = tokensOf(scope);
  if (tokens.length > 1 && GENERIC_PREFIXES.has(tokens[0])) tokens = tokens.slice(1);
  return tokens.map(titleToken).join(" ");
}

/** True when a name is a real name an author chose, not a slug/uuid/id. */
export function isHumanName(value: unknown): boolean {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (UUID_RE.test(text)) return false;
  if (NON_NAMES.has(text.toLowerCase())) return false;
  if (/^[0-9]+$/.test(text)) return false;
  // Short ids ('c1', 's-1') and prefixed ids ('child:abc') are not names.
  if (/^[a-z]{1,8}[-_:][a-z0-9]{1,8}$/i.test(text)) return false;
  if (SLUG_RE.test(text)) return false;
  // Markup, code or a bare token with punctuation is data, not a person.
  if (/[<>{}"`/\\|=+$#@!?*]/.test(text)) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  return /\s/.test(text) || /^[A-Z]/.test(text);
}

/** Split an already-composed label (`Bima · Skeleton Builder`). */
export function splitComposedName(value: unknown): { given: string; role: string } | null {
  const text = String(value ?? "").trim();
  const at = text.indexOf(" · ");
  if (at <= 0) return null;
  const given = text.slice(0, at).trim();
  const role = text.slice(at + 3).trim();
  if (!isHumanName(given)) return null;
  return { given, role };
}

/** Just the person part of a name: `Bima · Skeleton Builder` → `Bima`. */
export function givenNamePart(value: unknown): string {
  const composed = splitComposedName(value);
  return composed ? composed.given : String(value ?? "").trim();
}

/** Title-case a project/session label without inventing words. */
export function titleCase(value: unknown): string {
  const tokens = tokensOf(value);
  return tokens.map(titleToken).join(" ");
}

function usableManagerLabel(value: unknown, { minimum = 2 }: { minimum?: number } = {}): string {
  const text = String(value ?? "").trim();
  if (text.length < minimum) return "";
  if (UUID_RE.test(text)) return "";
  if (NON_NAMES.has(text.toLowerCase())) return "";
  if (/^[0-9]+$/.test(text)) return "";
  if (/^[0-9a-f]{8,}$/i.test(text)) return "";
  if (/[/\\]/.test(text)) return "";
  if (SLUG_RE.test(text) && !/[-_.]/.test(text) && text.length < 4) return "";
  return text;
}

/** A bounded user-approved title, not a transcript-derived summary. */
export function meaningfulSessionTitle(
  value: unknown,
  { project }: { project?: string } = {},
): string {
  if (typeof value !== "string") return "";
  // oxlint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const label = clean.replace(/(?:\s+manager)+$/i, "").trim();
  if (label.length < 2 || UUID_RE.test(label) || NON_NAMES.has(label.toLowerCase())) return "";
  if (/^[0-9a-f]{8,}$/i.test(label) || /^\d+$/.test(label) || /[<>]/.test(label)) return "";
  if (/^(?:[/\\~]|[a-z]:\\)/i.test(label)) return "";
  if (/^(?:session|untitled|new session|default|workflow|workflow manager)$/i.test(label)) return "";
  if (/^(?:subagent|child|worker)[-_:][\w.-]+$/i.test(label)) return "";
  // A previously generated project Manager label is not a user goal.
  if (/\smanager$/i.test(clean) && project && titleCase(label) === titleCase(project)) return "";
  return clampLabel(label, 200);
}

/** Session identity and orchestrator identity deliberately have different labels. */
export function sessionTitle({
  project,
  sessionName,
  goalTitle,
}: { project?: string; sessionName?: string; goalTitle?: string } = {}): string {
  const goal = meaningfulSessionTitle(goalTitle, { project });
  const name = meaningfulSessionTitle(sessionName, { project });
  const projectLabel = usableManagerLabel(project);
  return goal || name || (projectLabel ? clampLabel(titleCase(projectLabel), 200) : "Workflow");
}

/** The graph root is an authority, not another named worker. */
export function managerName(input: { project?: string; sessionName?: string; goalTitle?: string } = {}): string {
  return composeManagerName(sessionTitle(input));
}

/** Keep the " Manager" suffix intact even when the project name is long. */
function composeManagerName(label: string): string {
  const suffix = " Manager";
  return `${clampLabel(label, 40 - suffix.length)}${suffix}`;
}

/** The role noun for a worker, derived from purpose first, then scope. */
export function roleFor({ purpose, scope }: { purpose?: string; scope?: string } = {}): string {
  const purposeText = String(purpose ?? "").toLowerCase();
  for (const [pattern, role] of PURPOSE_ROLES) {
    if (pattern.test(purposeText)) return ROLE_LABELS[role];
  }
  const scopeText = tokensOf(scope).join(" ");
  for (const [pattern, role] of SCOPE_ROLES) {
    if (pattern.test(scopeText)) return ROLE_LABELS[role];
  }
  return ROLE_LABELS.builder;
}

/**
 * The given name for `id`, probing past names already in `usedNames`.
 *
 * The probe walks forward through the sorted dictionary, so the result depends
 * only on (id, usedNames) and never on iteration order. Past 278 concurrent
 * children the fallback is `<Name> 2`, `<Name> 3`, … in sorted id order.
 */
export function givenNameFor(id: unknown, usedNames: Iterable<string> = new Set<string>()): string {
  const used = usedNames instanceof Set ? new Set(usedNames) : new Set(usedNames);
  const start = fnv1a(id) % NAME_COUNT;
  for (let step = 0; step < NAME_COUNT; step += 1) {
    const candidate = JAVANESE_GIVEN_NAMES[(start + step) % NAME_COUNT];
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  // Exhausted: keep the deterministic base and suffix it until it is free.
  const base = JAVANESE_GIVEN_NAMES[start];
  let suffix = 2;
  while (used.has(`${base} ${suffix}`)) suffix += 1;
  const fallback = `${base} ${suffix}`;
  used.add(fallback);
  return fallback;
}

/**
 * Assign a given name to every entity id in one pass.
 *
 * Sorted-id iteration makes the assignment independent of the order the registry
 * happened to deliver, so a refresh cannot shuffle names. Explicit human names
 * claim their slot first and are handed back unchanged.
 */
export function assignGivenNames(
  entities: readonly (string | (NamingNode & { id: string }))[] = [],
): Map<string, string> {
  const list = (Array.isArray(entities) ? entities : [])
    .map((entity) => (typeof entity === "string" ? { id: entity } : entity))
    .filter((entity): entity is NamingNode & { id: string } =>
      Boolean(entity && typeof entity.id === "string" && entity.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const entity of list) {
    const explicit = givenNamePart(entity.name);
    if (isHumanName(explicit) && !used.has(explicit)) {
      used.add(explicit);
      names.set(entity.id, explicit);
    }
  }
  for (const entity of list) {
    if (names.has(entity.id)) continue;
    names.set(entity.id, givenNameFor(entity.id, used));
  }
  return names;
}

/** Trim a label to `max` characters on a word boundary with an ellipsis. */
export function clampLabel(value: unknown, max = 32): string {
  const text = String(value ?? "").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(1, max - 1));
  const boundary = cut.lastIndexOf(" ");
  const trimmed = boundary > max / 2 ? cut.slice(0, boundary) : cut;
  return `${trimmed.trimEnd()}…`;
}

export interface NamingNode {
  id?: string;
  name?: string;
  scope?: string;
  purpose?: string;
  kind?: string;
  title?: string;
  givenName?: string;
  project?: string;
}

export interface DisplayOptions {
  givenName?: string;
  max?: number;
  usedNames?: Set<string>;
}

/** `Spec · Repo Skeleton` — a handoff is an authored document, not a process. */
export function handoffDisplayName({ scope, id }: { scope?: string; id?: string } = {}): string {
  const subject = humanizeSlug(scope) || clampLabel(id, 24) || "Handoff";
  return clampLabel(`Spec · ${subject}`, 44);
}

/** Compose a node's display label. */
export function displayName(node: NamingNode = {}, options: DisplayOptions = {}): string {
  const kind = String(node.kind || "child");
  const max = Number.isFinite(options.max) ? Number(options.max) : 32;
  const subject = humanizeSlug(node.scope);
  const roleScope = roleSubject(node.scope);

  if (kind === "handoff") return handoffDisplayName(node);
  if (kind === "session") return managerName({ project: node.project, sessionName: node.name });

  if (kind === "review") {
    const given = options.givenName || node.givenName;
    if (given) return clampLabel(`${given} · Review`, max);
    return clampLabel(subject ? `${subject} Review` : "Review", max);
  }
  if (kind === "spec-review") {
    const title = String(node.title ?? "").trim() || clampLabel(node.id, 20);
    return clampLabel(`Spec Review · ${title}`, Math.max(max, 40));
  }
  if (kind === "escalation") {
    return clampLabel(`Escalation${subject ? ` · ${subject}` : ""}`, max);
  }

  const given = options.givenName || node.givenName
    || (isHumanName(node.name) ? givenNamePart(node.name) : "")
    || givenNameFor(node.id, options.usedNames || new Set());
  const role = roleFor(node);
  const roleLabel = roleScope ? `${roleScope} ${role}` : role;
  return clampLabel(`${given} · ${roleLabel}`, max);
}

/** Deterministic digest of the vendored list, so an accidental edit is visible. */
export function namesDigest(): string {
  return fnv1a(JAVANESE_GIVEN_NAMES.join("\u0000")).toString(16).padStart(8, "0");
}

/** Internals exposed for tests only; not part of the display API. */
export const __naming = Object.freeze({
  NAME_COUNT,
  ACRONYMS,
  GENERIC_PREFIXES,
  NAME_DIGEST: namesDigest(),
});
