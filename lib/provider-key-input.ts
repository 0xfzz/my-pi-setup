import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Input,
  matchesKey,
  renderFakeCursor,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

const AUTH_ALTERNATIVE = "Use /login or environment authentication instead.";
const INPUT_ERROR = `Unable to read a masked provider key. ${AUTH_ALTERNATIVE}`;

/** One interaction only. The Input owns editing/paste, but its renderer is never used. */
export class ProviderKeyInput implements Component, Focusable {
  #input: Input | undefined;
  #title: string;
  #done: (value: string | undefined) => void;
  #requestRender: () => void;

  constructor(title: string, done: (value: string | undefined) => void, requestRender: () => void) {
    this.#title = title;
    this.#done = done;
    this.#requestRender = requestRender;
    this.#input = new Input();
    this.#input.onSubmit = value => this.#finish(value);
    this.#input.onEscape = () => this.#finish(undefined);
  }

  get focused(): boolean {
    return this.#input?.focused ?? false;
  }

  set focused(value: boolean) {
    if (this.#input) this.#input.focused = value;
  }

  handleInput(data: string): void {
    if (!this.#input) return;
    try {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.#finish(undefined);
      } else {
        this.#input.handleInput(data);
      }
      this.#requestRender();
    } catch {
      // Never forward errors (or causes) that might contain input/paste data.
      this.dispose();
      throw new Error(INPUT_ERROR);
    }
  }

  render(width: number): string[] {
    const columns = Math.max(0, Math.floor(width));
    if (!this.#input || columns === 0) return [""];

    // Do not render then redact: pasted ANSI/OSC payloads must never reach output.
    // This is deliberately an end indicator, not a reflection of the editing cursor.
    const masks = "*".repeat(Math.min(this.#input.getValue().length, columns - 1));
    const cursor = this.focused ? CURSOR_MARKER + renderFakeCursor(" ") : " ";
    return [
      ...this.#title.split(/\r\n|\r|\n/).map(line => truncateToWidth(line, columns, "")),
      masks + cursor,
      truncateToWidth("Hidden input | Enter: submit | Esc/Ctrl+C: cancel", columns, ""),
    ];
  }

  invalidate(): void {
    this.#input?.invalidate();
  }

  dispose(): void {
    // Drop the whole instance, including its paste buffer, undo stack, and kill ring.
    // JS strings cannot be reliably zeroed; nothing is logged or persisted here.
    this.#input = undefined;
  }

  #finish(value: string | undefined): void {
    if (!this.#input) return;
    this.dispose();
    this.#done(value);
  }
}

/** Collect a secret locally; callers own validation and any eventual credential storage. */
export async function providerKeyInput(
  ctx: ExtensionCommandContext,
  title: string,
): Promise<string | undefined> {
  if (ctx.mode !== "tui") {
    throw new Error(`Masked provider key entry requires TUI mode. ${AUTH_ALTERNATIVE}`);
  }

  let component: ProviderKeyInput | undefined;
  try {
    return await ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) => {
      component = new ProviderKeyInput(title, done, () => tui.requestRender());
      return component;
    });
  } catch {
    throw new Error(INPUT_ERROR);
  } finally {
    component?.dispose();
  }
}
