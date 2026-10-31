import { canonicalize } from "../paths.ts";

export interface RefusalHit {
  path: string;
  matched: string;
}

const REFUSAL_ERROR_PATTERNS = [
  /Permission denied/i,
  /Read-only file system/i,
  /Operation not permitted/i,
  /\bEACCES\b/i,
  /\bEROFS\b/i,
  /\bEPERM\b/i,
];

// Patterns for extracting paths associated with errors:
// 1. Quoted paths: touch: cannot touch '/foo/bar': Read-only file system
// 2. Python: [Errno 13] Permission denied: '/foo/bar'
// 3. Node.js: Error: EACCES: permission denied, open '/foo/bar'
// 4. Shell: /bin/sh: /foo/bar: Permission denied
// 5. Bare path before colon: /foo/bar: Read-only file system
const PATH_LINE_PATTERNS: RegExp[] = [
  /(?:cannot (?:touch|create|open|write|remove|unlink|truncate)|permission denied|read-only file system)[^:\n]*?['"](\/[^'"\r\n]+)['"]/i,
  /['"](\/[^'"\r\n]+)['"][^:\n]*?(?:Permission denied|Read-only file system|Operation not permitted|EACCES|EROFS)/i,
  /(?:open|access|stat|unlink|mkdir|rmdir)['"]?\s*,\s*['"](\/[^'"\r\n]+)['"]/i,
  /(?:^|[\s:])(\/[a-zA-Z0-9_.][\w./-]*):\s*(?:Permission denied|Read-only file system|Operation not permitted|cannot open|cannot create)/im,
  /\[Errno 13\] Permission denied:\s*['"](\/[^'"\r\n]+)['"]/i,
  /EACCES:\s*permission denied,\s*(?:open|mkdir|unlink|access)\s*['"](\/[^'"\r\n]+)['"]/i,
];

function isCandidatePath(candidate: string): boolean {
  if (!candidate || !candidate.startsWith("/")) return false;
  // Ignore virtual system trees that are not regular file writes
  if (
    candidate === "/dev/null" ||
    candidate === "/dev/zero" ||
    candidate === "/dev/tty" ||
    candidate.startsWith("/proc/") ||
    candidate.startsWith("/sys/")
  ) {
    return false;
  }
  return true;
}

/**
 * Scan stderr/stdout text for permission refusal errors and extract absolute paths.
 */
export function scanRefusals(output: string): RefusalHit[] {
  if (!output || typeof output !== "string") return [];

  const hasRefusalError = REFUSAL_ERROR_PATTERNS.some(re => re.test(output));
  if (!hasRefusalError) return [];

  const lines = output.split(/\r?\n/);
  const hits: RefusalHit[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (!REFUSAL_ERROR_PATTERNS.some(re => re.test(line))) continue;

    for (const pattern of PATH_LINE_PATTERNS) {
      const match = pattern.exec(line);
      if (match && match[1]) {
        const rawPath = match[1].trim();
        if (isCandidatePath(rawPath)) {
          const canonical = canonicalize(rawPath);
          if (!seen.has(canonical)) {
            seen.add(canonical);
            hits.push({ path: canonical, matched: line.trim() });
          }
        }
      }
    }
  }

  return hits;
}

/**
 * Session-scoped deduplication of paths asked due to refusal.
 */
export class RefusalDeduper {
  private readonly asked = new Set<string>();

  has(path: string): boolean {
    return this.asked.has(path);
  }

  add(path: string): void {
    this.asked.add(path);
  }

  clear(): void {
    this.asked.clear();
  }
}
