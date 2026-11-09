// Composer: the message input with Enter-to-send (Shift+Enter for a newline)
// and a Stop button while the session is busy (streaming, thinking, tools).

import { useState, type KeyboardEvent } from "react";

export interface ComposerProps {
  disabled: boolean;
  /** Any UI state that means the session is busy: streaming, thinking, tools. */
  busy: boolean;
  error?: string | null;
  onSend: (text: string) => void;
  onAbort: () => void;
}

export function Composer({ disabled, busy, error, onSend, onAbort }: ComposerProps) {
  const [text, setText] = useState("");

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!disabled && text.trim() !== "") {
        onSend(text);
        setText("");
      }
    }
  };

  return (
    <div className="app-composer" data-busy={busy ? "true" : undefined}>
      <textarea
        className="app-composer-input"
        placeholder={disabled ? "Select or start a session…" : "Message pi…"}
        disabled={disabled}
        value={text}
        onChange={(event) => setText(event.target.value)}
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
