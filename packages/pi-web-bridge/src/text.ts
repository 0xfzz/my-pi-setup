/** Strip terminal styling, OSC/DCS and unsupported controls. HTML stays inert text. */
export function webUiText(text: string): string {
  return text
    // Deliberate ANSI/control matching: no terminal escapes reach browser models.
    // oxlint-disable-next-line no-control-regex
    .replace(/\x1b(?:\][\s\S]*?(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    // oxlint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
