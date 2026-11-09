// Composer: the message input with Enter-to-send (Shift+Enter for a newline)
// and a Stop button while a run is streaming.

import { useState, type KeyboardEvent } from "react";

export interface ComposerProps {
  disabled: boolean;
  streaming: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
}

export function Composer({ disabled, streaming, onSend, onAbort }: ComposerProps) {
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
    <div className="app-composer">
      <textarea
        className="app-composer-input"
        placeholder={disabled ? "Select or start a session…" : "Message pi…"}
        disabled={disabled}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        aria-label="Message pi"
      />
      {streaming ? (
        <button type="button" className="app-composer-abort" onClick={onAbort}>
          Stop
        </button>
      ) : null}
    </div>
  );
}
