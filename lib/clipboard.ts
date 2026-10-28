/**
 * Read the system clipboard on Linux without assuming which display server the
 * user is on.
 *
 * Pi's built-in reader has two gaps that make paste fail silently in a plain
 * terminal while working inside a multiplexer like Herdr:
 *
 * 1. `wl-paste` is only attempted when `WAYLAND_DISPLAY` is exported. The socket
 *    is discoverable without it (`$XDG_RUNTIME_DIR/wayland-0`), so a Pi started
 *    from an X11-ish launcher, over ssh or from a service never tries Wayland at
 *    all and falls through to `xclip`.
 * 2. `xclip -o` asks for `STRING`, which many toolkits do not offer; the
 *    clipboard is non-empty but the read fails. The explicit targets
 *    (`UTF8_STRING`, `text/plain;charset=utf-8`) have to be tried in order.
 *
 * Everything here is injectable so the backend order can be tested without a
 * display server: `run` executes a command, `exists`/`readdir` probe sockets.
 */

import { existsSync, readdirSync } from "node:fs";

export interface ClipboardRunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
}

export type ClipboardRun = (
  command: string,
  args: string[],
  options?: ClipboardRunOptions,
) => Promise<Buffer | undefined>;

export interface ClipboardEnv {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  exists: (path: string) => boolean;
  readdir: (path: string) => string[];
}

export interface ClipboardImage {
  bytes: Buffer;
  mimeType: string;
}

export interface ClipboardRead {
  text?: string;
  files?: string[];
  image?: ClipboardImage;
  /** Human-readable list of what was tried, for the "nothing to paste" message. */
  attempts: string[];
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/**
 * Identify an image by its magic number.
 *
 * The clipboard often offers *only* an image, and `wl-paste` without `--type`
 * returns the first offered type — the raw PNG bytes. Decoding those as UTF-8
 * put a screenful of binary into the prompt instead of an attachment, so every
 * read is sniffed before it can be treated as text.
 */
export function sniffImage(bytes: Buffer): string | undefined {
  const at = (offset: number, length: number) => bytes.toString("latin1", offset, offset + length);
  if (bytes.length >= 4 && bytes[0] === 0x89 && at(1, 3) === "PNG") return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 4 && at(0, 4) === "GIF8") return "image/gif";
  if (bytes.length >= 12 && at(0, 4) === "RIFF" && at(8, 4) === "WEBP") return "image/webp";
  return undefined;
}

/** Text, not bytes that merely happen to decode. */
export function looksLikeText(bytes: Buffer): boolean {
  if (!bytes.length) return false;
  if (sniffImage(bytes)) return false;
  // A NUL byte in the first block is the cheapest reliable "this is binary" test
  // and covers the formats we do not special-case.
  if (bytes.subarray(0, 4096).includes(0)) return false;
  // U+FFFD means the bytes were not valid UTF-8.
  return !bytes.toString("utf8").includes("\uFFFD");
}

/** `wayland-0` from the env, else the first usable socket in the runtime dir. */
export function waylandDisplay(env: NodeJS.ProcessEnv, exists: (path: string) => boolean, readdir: (path: string) => string[]): string | undefined {
  if (env.WAYLAND_DISPLAY) return env.WAYLAND_DISPLAY;
  const runtime = env.XDG_RUNTIME_DIR;
  if (!runtime) return undefined;
  const direct = "wayland-0";
  if (exists(`${runtime}/${direct}`)) return direct;
  try {
    const candidate = readdir(runtime)
      .filter(name => name.startsWith("wayland-") && !name.endsWith(".lock"))
      .sort()[0];
    return candidate;
  } catch {
    return undefined;
  }
}

/** `text/uri-list` or `file://` lines into plain paths. */
export function parseUriList(value: string): string[] {
  const paths: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.startsWith("file://")) continue;
    try {
      paths.push(decodeURIComponent(new URL(trimmed).pathname));
    } catch {
      // Ignore a malformed URI rather than failing the whole paste.
    }
  }
  return paths;
}

/** Try each (command, args) until one produces a non-empty, non-error result. */
async function first(
  run: ClipboardRun,
  attempts: string[],
  candidates: Array<[string, string[]]>,
  env: NodeJS.ProcessEnv,
): Promise<Buffer | undefined> {
  for (const [command, args] of candidates) {
    attempts.push(`${command} ${args.join(" ")}`.trim());
    try {
      const result = await run(command, args, { env, timeoutMs: 2000 });
      if (result && result.length) return result;
    } catch {
      // A missing helper is expected on most systems; keep the next candidate.
    }
  }
  return undefined;
}

export interface ReadClipboardOptions extends Partial<ClipboardEnv> {
  run: ClipboardRun;
  /** Overrides the platform detection, for tests. */
  platform?: NodeJS.Platform;
}

/**
 * Read text, file paths or an image, whichever the clipboard actually offers.
 *
 * Files win over images, and images over text: a screenshot copied from a file
 * manager offers all three, and the path is what the model can act on.
 */
export async function readClipboard(options: ReadClipboardOptions): Promise<ClipboardRead | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  // Real filesystem probes by default; tests inject their own. Without this the
  // socket discovery below could never fire in a production session.
  const exists = options.exists ?? existsSync;
  const readdir = options.readdir ?? ((path: string) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  });
  if (platform !== "linux") return undefined;

  const attempts: string[] = [];
  const { run } = options;
  const withEnv = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, ...extra });

  const candidates: Array<[string, string[]]> = [];
  let childEnv = env;

  if (env.TERMUX_VERSION) candidates.push(["termux-clipboard-get", []]);

  const wayland = waylandDisplay(env, exists, readdir);
  if (wayland) {
    childEnv = withEnv({ WAYLAND_DISPLAY: wayland });
    candidates.push(
      ["wl-paste", ["--no-newline", "--type", "text/uri-list"]],
      ["wl-paste", ["--no-newline", "--type", "text/plain;charset=utf-8"]],
      ["wl-paste", ["--no-newline", "--type", "text/plain"]],
    );
  } else {
    attempts.push("wayland: no socket found");
  }

  // `DISPLAY` is not required: xclip also works through an X11 socket forwarded
  // by ssh or set by a wrapper, so the helper is tried whenever it exists.
  candidates.push(
    ["xclip", ["-selection", "clipboard", "-out", "-target", "text/uri-list"]],
    ["xclip", ["-selection", "clipboard", "-out", "-target", "UTF8_STRING"]],
    ["xclip", ["-selection", "clipboard", "-out", "-target", "text/plain;charset=utf-8"]],
    ["xclip", ["-selection", "clipboard", "-out", "-target", "STRING"]],
    ["xsel", ["--clipboard", "--output"]],
  );

  // A multiplexer paste buffer is what `prefix + ]` would insert. Optional, and
  // tried last because it is often stale.
  if (env.TMUX) candidates.push(["tmux", ["save-buffer", "-"]]);

  for (const [command, args] of candidates) {
    attempts.push(`${command} ${args.join(" ")}`.trim());
    let result: Buffer | undefined;
    try {
      result = await run(command, args, { env: childEnv, timeoutMs: 2000 });
    } catch {
      continue;
    }
    if (!result || !result.length) continue;
    // A backend that hands back an image (or binary) must never become text.
    const mime = sniffImage(result);
    if (mime) return { image: { bytes: result, mimeType: mime }, attempts };
    if (!looksLikeText(result)) continue;
    const value = result.toString("utf8");
    if (args.includes("text/uri-list")) {
      const files = parseUriList(value);
      if (files.length) return { files, attempts };
      continue;
    }
    return { text: value, attempts };
  }

  // No text anywhere: an image-only clipboard is still a paste.
  for (const mimeType of IMAGE_TYPES) {
    const imageCandidates: Array<[string, string[]]> = [];
    if (wayland) imageCandidates.push(["wl-paste", ["--type", mimeType]]);
    imageCandidates.push(["xclip", ["-selection", "clipboard", "-out", "-target", mimeType]]);
    const bytes = await first(run, attempts, imageCandidates, childEnv);
    if (bytes && bytes.length) return { image: { bytes, mimeType }, attempts };
  }

  return undefined;
}

/** Message shown when the clipboard held nothing this reader could use. */
export function describeClipboardFailure(read: ClipboardRead | undefined, options: { terminalPasteKey: string }): string {
  const tried = read?.attempts?.length ? ` Tried: ${read.attempts.slice(0, 3).join(", ")}${read.attempts.length > 3 ? "…" : ""}.` : "";
  return `Clipboard: nothing readable.${tried} Install wl-clipboard or xclip, or paste with ${options.terminalPasteKey} (your terminal's own paste).`;
}
