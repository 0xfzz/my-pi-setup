/**
 * Clipboard paste that works in every Linux terminal.
 *
 * Pi's built-in `Ctrl+V` reads the clipboard itself, but only tries `wl-paste`
 * when `WAYLAND_DISPLAY` is exported and only asks `xclip` for the `STRING`
 * target — which many toolkits do not offer. When that read comes back empty,
 * nothing happens and nothing is reported, so paste looks broken while the
 * terminal's own paste (Herdr's, tmux's, `Ctrl+Shift+V`) still works.
 *
 * This extension composes over the installed editor, claims the same paste key,
 * and inserts text, file paths or an image using a reader that tries the tmux
 * buffer, every Wayland socket, and X11 with explicit targets. When it still
 * finds nothing it says so instead of failing silently.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import {
  describeClipboardFailure,
  readClipboard,
  type ClipboardRead,
  type ClipboardRun,
} from "../lib/clipboard.ts";
import { isSubagentChildSession } from "../lib/subagent-context.ts";

export type PasteOutcome = "pasted" | "empty" | "delegated";

export interface PasteDeps {
  read: () => Promise<ClipboardRead | undefined>;
  notify: (message: string, level: "warning" | "info") => void;
  /** Persist an image and return the path that will be inserted. */
  writeImage?: (image: NonNullable<ClipboardRead["image"]>) => string;
  platform?: NodeJS.Platform;
}

function defaultWriteImage(image: NonNullable<ClipboardRead["image"]>): string {
  const ext = image.mimeType.split("/")[1] ?? "png";
  const file = join(tmpdir(), `pi-clipboard-${randomUUID()}.${ext === "jpeg" ? "jpg" : ext}`);
  writeFileSync(file, image.bytes);
  return file;
}

/**
 * Insert whatever the clipboard holds into the editor.
 *
 * Returns `delegated` when this is not a Linux session: pi's own reader handles
 * macOS/Windows (Finder file copies, native images) better than anything here.
 */
export async function insertClipboard(
  editor: { insertTextAtCursor?: (text: string) => void; insertText?: (text: string) => void },
  deps: PasteDeps,
): Promise<PasteOutcome> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") return "delegated";

  let read: ClipboardRead | undefined;
  try {
    read = await deps.read();
  } catch {
    read = undefined;
  }
  const insert = (text: string) => {
    if (editor.insertTextAtCursor) editor.insertTextAtCursor(text);
    else editor.insertText?.(text);
  };

  if (read?.files?.length) {
    insert(read.files.join("\n"));
    return "pasted";
  }
  if (read?.image) {
    insert((deps.writeImage ?? defaultWriteImage)(read.image));
    return "pasted";
  }
  if (read?.text) {
    insert(read.text);
    return "pasted";
  }
  deps.notify(describeClipboardFailure(read, { terminalPasteKey: "Ctrl+Shift+V" }), "warning");
  return "empty";
}

/** Spawn a helper with a hard timeout; a missing command is just `undefined`. */
export const systemRun: ClipboardRun = (command, args, options) =>
  new Promise(resolve => {
    let settled = false;
    const finish = (value: Buffer | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(command, args, { env: options?.env, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      finish(undefined);
      return;
    }
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, options?.timeoutMs ?? 2000);
    child.stdout?.on("data", chunk => chunks.push(Buffer.from(chunk)));
    child.on("error", () => {
      clearTimeout(timer);
      finish(undefined);
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish(chunks.length ? Buffer.concat(chunks) : undefined);
    });
  });

/** The reader this extension uses: all Linux backends, in order. */
export function readSystemClipboard(): Promise<ClipboardRead | undefined> {
  return readClipboard({ run: systemRun });
}

export default function clipboardPaste(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let installedEditor: EditorFactory | undefined;
  let baseEditor: EditorFactory | undefined;

  const apply = (ctx: ExtensionContext) => {
    context = ctx;
    if (ctx.mode !== "tui" || isSubagentChildSession(ctx)) return;
    if (typeof ctx.ui.setEditorComponent !== "function") return;
    const previous = typeof ctx.ui.getEditorComponent === "function" ? ctx.ui.getEditorComponent() : undefined;
    if (previous !== installedEditor) baseEditor = previous;
    const base = baseEditor;
    installedEditor = (tui, theme, keybindings) => {
      const editor = base?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
      const handleBaseInput = editor.handleInput.bind(editor);
      editor.handleInput = (data: string) => {
        // Respect a user remap of the paste action; fall back to the default key
        // when the keybindings manager is not available (tests, RPC).
        const pasteKey = keybindings?.matches
          ? keybindings.matches(data, "app.clipboard.pasteImage")
          : matchesKey(data, "ctrl+v");
        if (!pasteKey) return handleBaseInput(data);
        void insertClipboard(editor, {
          read: readSystemClipboard,
          notify: (message, level) => context?.ui.notify(message, level),
        }).then(outcome => {
          // macOS/Windows keep pi's own paste, which handles Finder file copies.
          if (outcome === "delegated") (editor as { onPasteImage?: () => void }).onPasteImage?.();
          tui.requestRender();
        });
      };
      return editor;
    };
    ctx.ui.setEditorComponent(installedEditor);
  };

  pi.on("session_start", (_event, ctx) => apply(ctx));
  pi.on("session_tree", (_event, ctx) => apply(ctx));
  pi.on("before_agent_start", (_event, ctx) => { context = ctx; });
  pi.on("session_shutdown", () => {
    if (!installedEditor || !context) return;
    try {
      context.ui.setEditorComponent(undefined);
    } finally {
      installedEditor = undefined;
      baseEditor = undefined;
    }
  });
}

/** Derive from the UI contract so this does not depend on a re-exported alias. */
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
