// Deliberate control matching: no terminal escapes reach browser models.
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

/** Strip terminal styling, OSC/DCS and unsupported controls. HTML stays inert text. */
export function webUiText(text: string): string {
  // Clean text is the common case; skip both replacements and return the
  // original string rather than allocating a copy for every envelope field.
  if (!CONTROL.test(text)) return text;
  return text
    // oxlint-disable-next-line no-control-regex
    .replace(/\x1b(?:\][\s\S]*?(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    // oxlint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
