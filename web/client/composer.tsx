// Composer: the message input with Enter-to-send (Shift+Enter for a newline)
// and a Stop button while the session is busy (streaming, thinking, tools).
// Typing "/" opens the slash-command palette: the live session's dispatchable
// commands first, then pi's built-ins (marked TUI); ArrowUp/Down move, Tab or
// Enter completes, Esc dismisses.
// Images attach by pasting into the input or picking files; they are
// downscaled client-side (max 1568px, JPEG re-encode when still large) so a
// screenshot never needs a multi-megabyte request.

import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { filterCommands, type WebCommand } from "../shared/commands.ts";

export interface PendingImage {
  id: number;
  data: string;
  mimeType: string;
}

export interface ComposerProps {
  disabled: boolean;
  /** Any UI state that means the session is busy: streaming, thinking, tools. */
  busy: boolean;
  error?: string | null;
  onSend: (text: string, images: PendingImage[]) => void;
  onAbort: () => void;
  /** Commands the selected session dispatches (extension/prompt/skill). */
  sessionCommands?: WebCommand[];
  /** pi's built-in slash commands (TUI-side; listed for discovery). */
  builtinCommands?: readonly WebCommand[];
  /** The current model, shown as a chip that opens the web picker. */
  model?: { provider: string; id: string };
  /** The current thinking level, shown as a chip that opens its picker. */
  thinkingLevel?: string;
  /** Opens the web model picker (the chip or bare /model). */
  onOpenModelPicker?: () => void;
  /** Opens the web thinking picker (the chip or bare /thinking). */
  onOpenThinkingPicker?: () => void;
  /** A web-ported command was invoked: the shell runs the web side of it. */
  onWebCommand?: (name: string, args: string) => void;
}

const PALETTE_LIMIT = 8;
/** The longest edge an attachment keeps; larger images are scaled down. */
const IMAGE_MAX_EDGE = 1568;
/** Re-encode as JPEG when the PNG data URL is still above this. */
const IMAGE_PNG_SOFT_LIMIT = 1_200_000;

interface ReadImage {
  data: string;
  mimeType: string;
}

async function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("could not read the file"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("could not decode the image"));
    image.src = src;
  });
}

/** Downscale a data-URL image: cap the long edge, re-encode when still big. */
async function downscaleDataUrl(dataUrl: string, mimeType: string): Promise<ReadImage> {
  const image = await loadImage(dataUrl);
  const longest = Math.max(image.width, image.height);
  if (longest <= IMAGE_MAX_EDGE && dataUrl.length <= IMAGE_PNG_SOFT_LIMIT) {
    return { data: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType };
  }
  const scale = Math.min(1, IMAGE_MAX_EDGE / longest);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d");
  if (context === null) return { data: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType };
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  let encoded = canvas.toDataURL("image/png");
  if (encoded.length > IMAGE_PNG_SOFT_LIMIT) {
    encoded = canvas.toDataURL("image/jpeg", 0.85);
    return { data: encoded.slice(encoded.indexOf(",") + 1), mimeType: "image/jpeg" };
  }
  return { data: encoded.slice(encoded.indexOf(",") + 1), mimeType: "image/png" };
}

export function Composer({
  disabled,
  busy,
  error,
  onSend,
  onAbort,
  sessionCommands,
  builtinCommands,
  model,
  thinkingLevel,
  onOpenModelPicker,
  onOpenThinkingPicker,
  onWebCommand,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  /** Local composer feedback (a blocked TUI-only command); cleared on typing. */
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Session commands first (they dispatch), built-ins after, deduped by name.
  const commands = useMemo(() => {
    const seen = new Set<string>();
    const merged: WebCommand[] = [];
    for (const command of [...(sessionCommands ?? []), ...(builtinCommands ?? [])]) {
      if (seen.has(command.name)) continue;
      seen.add(command.name);
      merged.push(command);
    }
    return merged;
  }, [sessionCommands, builtinCommands]);

  const slashPrefix = text.startsWith("/") && !text.includes(" ") ? text.slice(1) : null;
  const matches = useMemo(
    () => (slashPrefix === null ? [] : filterCommands(commands, slashPrefix).slice(0, PALETTE_LIMIT)),
    [slashPrefix, commands],
  );
  const paletteOpen = slashPrefix !== null && matches.length > 0 && !paletteDismissed;
  const highlighted = paletteOpen ? matches[paletteIndex] : undefined;

  // Keep the highlight inside the (re-filtered) list.
  useEffect(() => {
    if (paletteIndex >= matches.length) setPaletteIndex(0);
  }, [matches.length, paletteIndex]);

  const complete = (command: WebCommand): void => {
    setText(`/${command.name} `);
    setPaletteDismissed(false);
    inputRef.current?.focus();
  };

  const addImages = async (files: Blob[]): Promise<void> => {
    const next: PendingImage[] = [];
    for (const file of files.slice(0, 8)) {
      try {
        const dataUrl = await readAsDataUrl(file);
        const read = await downscaleDataUrl(dataUrl, file.type || "image/png");
        next.push({ id: Date.now() + next.length + Math.random(), data: read.data, mimeType: read.mimeType });
      } catch {
        // A file that cannot be decoded is skipped; the send still works.
      }
    }
    if (next.length > 0) setImages((prev) => [...prev, ...next].slice(0, 8));
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    void addImages(files);
  };

  const send = (): void => {
    if (text.trim() === "" && images.length === 0) return;
    // The web dialog port: commands pi's TUI answers with a selector are
    // answered HERE with a web dialog instead. Bare /model opens the picker
    // (like the TUI); /model <ref> applies it directly. The rest — session,
    // changelog, copy, export, resume — are web-side actions.
    const firstToken = text.startsWith("/") ? text.slice(1).split(" ")[0] : null;
    if (firstToken !== null && firstToken !== "") {
      const rest = text.slice(1 + firstToken.length).trim();
      const webPorted = [builtinCommands ?? [], sessionCommands ?? []]
        .flat()
        .find((command) => command.name === firstToken && command.webPorted === true);
      if (webPorted !== undefined) {
        if (onWebCommand !== undefined) onWebCommand(firstToken, rest);
        setText("");
        setImages([]);
        setPaletteDismissed(false);
        setNotice(null);
        return;
      }
      const dispatchable = commands.some(
        (command) => command.name === firstToken && command.tuiOnly !== true,
      );
      const tuiOnly = commands.find(
        (command) => command.name === firstToken && command.tuiOnly === true,
      );
      if (tuiOnly !== undefined && !dispatchable) {
        setNotice(
          `/${firstToken} is a TUI command — it needs the terminal. Run it there, or pick a command the web can run.`,
        );
        return;
      }
    }
    onSend(text, images);
    setText("");
    setImages([]);
    setPaletteDismissed(false);
    setNotice(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (paletteOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setPaletteIndex((index) => (index + 1) % matches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setPaletteIndex((index) => (index - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        if (highlighted !== undefined) complete(highlighted);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setPaletteDismissed(true);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && highlighted !== undefined
        && text !== `/${highlighted.name}`) {
        // Completing the highlighted name; sending happens on the next Enter
        // once the text is the full command.
        event.preventDefault();
        complete(highlighted);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!disabled && (text.trim() !== "" || images.length > 0)) {
        send();
      }
    }
  };

  return (
    <div className="app-composer" data-busy={busy ? "true" : undefined}>
      {(model !== undefined || thinkingLevel !== undefined) ? (
        <div className="app-composer-meta">
          {model !== undefined && onOpenModelPicker !== undefined ? (
            <button
              type="button"
              className="app-model-chip"
              onClick={onOpenModelPicker}
              title="Change the session model (syncs with the terminal)"
            >
              <span className="app-model-chip-provider">{model.provider}</span>
              <span className="app-model-chip-id">{model.id}</span>
            </button>
          ) : null}
          {thinkingLevel !== undefined && thinkingLevel !== "off" && onOpenThinkingPicker !== undefined ? (
            <button
              type="button"
              className="app-thinking-chip"
              onClick={onOpenThinkingPicker}
              title="Change the thinking level (syncs with the terminal)"
            >
              ✦ {thinkingLevel}
            </button>
          ) : null}
        </div>
      ) : null}
      {paletteOpen ? (
        <div className="app-command-palette" role="listbox" aria-label="Commands">
          {matches.map((command, index) => (
            <button
              key={command.name}
              type="button"
              role="option"
              aria-selected={index === paletteIndex}
              className={`app-command-item${index === paletteIndex ? " is-highlighted" : ""}`}
              onMouseEnter={() => setPaletteIndex(index)}
              onClick={() => complete(command)}
            >
              <code className="app-command-name">/{command.name}</code>
              {command.description ? (
                <span className="app-command-description">{command.description}</span>
              ) : null}
              {command.tuiOnly === true ? <span className="app-command-tui">TUI</span> : null}
              {command.webPorted === true ? <span className="app-command-web">web</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {images.length > 0 ? (
        <div className="app-attachments">
          {images.map((image) => (
            <span key={image.id} className="app-attachment">
              <img src={`data:${image.mimeType};base64,${image.data}`} alt="attachment" />
              <button
                type="button"
                className="app-attachment-remove"
                aria-label="Remove attachment"
                onClick={() => setImages((prev) => prev.filter((item) => item.id !== image.id))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="app-composer-row">
      <textarea
        className="app-composer-input"
        placeholder={disabled ? "Select or start a session…" : "Message pi… (/ for commands, paste to attach)"}
        disabled={disabled}
        value={text}
        ref={inputRef}
        onChange={(event) => {
          setText(event.target.value);
          setPaletteDismissed(false);
          setNotice(null);
        }}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
        aria-label="Message pi"
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="app-attach-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0) void addImages(files);
        }}
      />
      <button
        type="button"
        className="app-attach-button"
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled}
        title="Attach images"
        aria-label="Attach images"
      >
        📎
      </button>
      {busy ? (
        <button
          type="button"
          className="app-composer-abort"
          onClick={onAbort}
          title="Interrupt the running turn (like Escape in the TUI)"
        >
          Stop
        </button>
      ) : null}
      </div>
      {notice ? <div className="app-composer-error" role="alert">{notice}</div> : null}
      {error ? <div className="app-composer-error" role="alert">{error}</div> : null}
    </div>
  );
}
