// Composer: the message input with Enter-to-send (Shift+Enter for a newline)
// and a Stop button while the session is busy (streaming, thinking, tools).
// Typing "/" opens the slash-command palette: the live session's dispatchable
// commands first, then pi's built-ins (marked TUI); ArrowUp/Down move, Tab or
// Enter completes, Esc dismisses.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { filterCommands, type WebCommand } from "../shared/commands.ts";

export interface ComposerProps {
  disabled: boolean;
  /** Any UI state that means the session is busy: streaming, thinking, tools. */
  busy: boolean;
  error?: string | null;
  onSend: (text: string) => void;
  onAbort: () => void;
  /** Commands the selected session dispatches (extension/prompt/skill). */
  sessionCommands?: WebCommand[];
  /** pi's built-in slash commands (TUI-side; listed for discovery). */
  builtinCommands?: readonly WebCommand[];
}

const PALETTE_LIMIT = 8;

export function Composer({
  disabled,
  busy,
  error,
  onSend,
  onAbort,
  sessionCommands,
  builtinCommands,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

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

  const send = (): void => {
    if (text.trim() === "") return;
    onSend(text);
    setText("");
    setPaletteDismissed(false);
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
      if (!disabled && text.trim() !== "") {
        send();
      }
    }
  };

  return (
    <div className="app-composer" data-busy={busy ? "true" : undefined}>
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
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        className="app-composer-input"
        placeholder={disabled ? "Select or start a session…" : "Message pi… (/ for commands)"}
        disabled={disabled}
        value={text}
        ref={inputRef}
        onChange={(event) => {
          setText(event.target.value);
          setPaletteDismissed(false);
        }}
        onKeyDown={handleKeyDown}
        aria-label="Message pi"
      />
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
      {error ? <div className="app-composer-error" role="alert">{error}</div> : null}
    </div>
  );
}
