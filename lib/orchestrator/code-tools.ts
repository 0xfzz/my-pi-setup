/**
 * code-tools.ts — structured, path-guarded views of the repository.
 *
 * `code_search` is a thin call into the engine layer (§search-engine.ts); this
 * module supplies the two views a reviewer needs alongside it:
 *
 * - `code_map`: what exists, without opening every file. File listing comes from
 *   `rg --files` (or `git ls-files`), never a JavaScript directory walk.
 * - `code_read`: a bounded, line-numbered read with a digest, so a review can
 *   cite "path at sha256:…, lines 40–90" instead of "somewhere in this file".
 *
 * Both take a path guard from the caller, so reviewer roots and the control-plane
 * deny list are enforced before any read happens.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

import type { CommandRunner } from "./search-engine.ts";

export interface CodeToolsDeps {
  cwd: string;
  runner: CommandRunner;
  /** Returns a refusal message when the path is outside the caller's roots. */
  guard: (candidate: string) => string | undefined;
  stat?: (path: string) => { size: number; isFile: boolean } | undefined;
  readFile?: (path: string) => string;
  timeoutMs?: number;
}

const LANGUAGES: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin",
  ".rb": "ruby", ".php": "php", ".cs": "csharp", ".swift": "swift", ".scala": "scala",
  ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell",
  ".md": "markdown", ".mdx": "markdown", ".json": "json", ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml", ".sql": "sql", ".css": "css", ".scss": "scss", ".html": "html",
};

export function languageOf(path: string): string {
  return LANGUAGES[extname(path).toLowerCase()] ?? "text";
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface CodeMapFile {
  path: string;
  language: string;
  bytes: number;
  symbols?: Array<{ name: string; kind: "function" | "class" | "type" | "const" | "export"; line: number }>;
}

export interface CodeMapResult {
  root: string;
  files: CodeMapFile[];
  truncated: boolean;
  ignored: string[];
}

/** `rg --files`, then `git ls-files`. Both are native; neither recurses in JS. */
export async function listRepoFiles(
  input: { path?: string; maxFiles: number },
  deps: CodeToolsDeps,
): Promise<string[]> {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const rgArgv = ["--files", "--color", "never", "--no-config", ...(input.path ? ["--", input.path] : [])];
  const rg = await deps.runner.run("rg", rgArgv, { cwd: deps.cwd, timeoutMs });
  if (rg.exitCode === 0) {
    return rg.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, input.maxFiles);
  }

  const git = await deps.runner.run("git", ["ls-files"], { cwd: deps.cwd, timeoutMs });
  if (git.exitCode === 0) {
    const prefix = input.path ? input.path.replace(/\/+$/, "") : "";
    return git.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => Boolean(line) && (!prefix || line === prefix || line.startsWith(`${prefix}/`)))
      .slice(0, input.maxFiles);
  }

  throw new Error("cannot list repository files: rg --files and git ls-files both failed");
}

const SYMBOL_PATTERN = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|const|enum)\s+([A-Za-z_$][\w$]*)/;
const MAX_SYMBOL_BYTES = 512 * 1024;
const MAX_SYMBOL_FILES = 200;

function symbolsOf(content: string): CodeMapFile["symbols"] {
  const out: NonNullable<CodeMapFile["symbols"]> = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length && out.length < 20; index += 1) {
    const match = lines[index]!.match(SYMBOL_PATTERN);
    if (!match) continue;
    const raw = match[1]!;
    const kind = raw === "function" ? "function" : raw === "class" ? "class" : raw === "const" || raw === "enum" ? "const" : "type";
    out.push({ name: match[2]!, kind, line: index + 1 });
  }
  return out.length ? out : undefined;
}

export async function codeMap(
  input: { path?: string; depth?: number; maxFiles?: number; includeSymbols?: boolean },
  deps: CodeToolsDeps,
): Promise<CodeMapResult> {
  const maxFiles = Math.max(1, Math.min(input.maxFiles ?? 400, 800));
  const depth = input.depth == null ? undefined : Math.max(1, Math.min(input.depth, 4));
  const listed = await listRepoFiles({ path: input.path, maxFiles: maxFiles + 1 }, deps);
  const truncatedByCap = listed.length > maxFiles;
  const candidates = listed.slice(0, maxFiles).filter((path) => {
    if (depth == null) return true;
    return path.split("/").length <= depth! + 1;
  });

  const stat = deps.stat ?? ((path: string) => {
    try {
      const info = statSync(path);
      return { size: info.size, isFile: info.isFile() };
    } catch {
      return undefined;
    }
  });
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  let symbolBudget = MAX_SYMBOL_FILES;
  const files: CodeMapFile[] = [];
  for (const path of candidates) {
    const absolute = resolve(deps.cwd, path);
    const info = stat(absolute);
    if (!info?.isFile) continue;
    const entry: CodeMapFile = { path, language: languageOf(path), bytes: info.size };
    if (input.includeSymbols !== false && symbolBudget > 0 && info.size <= MAX_SYMBOL_BYTES) {
      symbolBudget -= 1;
      try {
        const symbols = symbolsOf(readFile(absolute));
        if (symbols) entry.symbols = symbols;
      } catch {
        // An unreadable file is listed without symbols rather than failing the map.
      }
    }
    files.push(entry);
  }

  return {
    root: resolve(deps.cwd, input.path ?? "."),
    files,
    truncated: truncatedByCap,
    ignored: ["node_modules", ".git", "dist", "coverage"],
  };
}

export interface CodeReadResult {
  path: string;
  language: string;
  lines: Array<{ n: number; text: string }>;
  digest: string;
  truncated: boolean;
}

export function codeRead(
  input: { path: string; start?: number; limit?: number; maxBytes?: number },
  deps: CodeToolsDeps,
): CodeReadResult {
  const refusal = deps.guard(input.path);
  if (refusal) throw new Error(refusal);
  if (!String(input.path ?? "").trim()) throw new Error("code_read needs a path");

  const absolute = resolve(deps.cwd, input.path);
  const stat = deps.stat ?? ((path: string) => {
    try {
      const info = statSync(path);
      return { size: info.size, isFile: info.isFile() };
    } catch {
      return undefined;
    }
  });
  const info = stat(absolute);
  if (!info?.isFile) throw new Error(`${input.path} is not a readable file`);

  const maxBytes = Math.max(1, Math.min(input.maxBytes ?? 80_000, 200_000));
  const start = Math.max(1, input.start ?? 1);
  if (info.size > maxBytes && input.start == null) {
    throw new Error(`${input.path} is ${info.size} bytes, over the ${maxBytes}-byte cap; pass start/limit to read a range`);
  }

  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const content = readFile(absolute);
  if (content.includes("\u0000")) throw new Error(`${input.path} looks binary; code_read only reads text`);

  const all = content.split("\n");
  const limit = Math.max(1, Math.min(input.limit ?? 200, 800));
  const window = all.slice(start - 1, start - 1 + limit);
  const bytes = Buffer.byteLength(window.join("\n"), "utf8");

  return {
    path: input.path,
    language: languageOf(input.path),
    lines: window.map((text, index) => ({ n: start + index, text })),
    digest: sha256(content),
    truncated: start - 1 + window.length < all.length || bytes > maxBytes,
  };
}
