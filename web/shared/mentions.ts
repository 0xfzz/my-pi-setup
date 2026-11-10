// Shared @-mention helpers (client-side UX only).
//
// pi owns the behavior: the composer gates WHEN a picker appears (an @token
// at the caret); the suggestions themselves come from pi's own editor
// autocomplete via the pi_api `autocomplete.suggestions` call, and a sent
// `@path` rides the prompt as text — pi's read tool resolves it (it strips
// the `@` prefix natively). Nothing here re-implements pi.

/** The @token currently being typed at the caret, if any. */
export function activeMentionToken(textBeforeCaret: string): string | null {
  const match = /(^|\s)@([^\s]*)$/.exec(textBeforeCaret);
  return match === null ? null : (match[2] ?? "");
}
