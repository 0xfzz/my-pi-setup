/** Add modes here; UI, /mode completions, and cycling follow this registry. */
export interface ModeDefinition {
  id: string;
  label: string;
  /** Plain, single-column glyphs: no emoji/Nerd Font dependency. */
  icon?: string;
  summary?: string;
  tone?: "accent" | "warning" | "success";
  hint: string;
  cycleable?: boolean;
  route(text: string): string;
}

export const MODES: readonly ModeDefinition[] = [
  { id: "normal", label: "Normal", icon: "󰚥", summary: "AI chat & tools", tone: "accent", hint: "Chat with AI", route: text => text },
  { id: "plan", label: "Plan", icon: "󰏫", summary: "Read; artifacts RW", tone: "success", hint: "Explore / plan · writes only to artifacts · /plan off to exit", route: text => text },
];

export class ModeRegistry {
  private index = 0;
  readonly modes: readonly ModeDefinition[];
  constructor(modes: readonly ModeDefinition[] = MODES) {
    this.modes = modes;
    if (!modes.length || new Set(modes.map(mode => mode.id)).size !== modes.length) {
      throw new Error("Modes must be non-empty and have unique IDs");
    }
  }
  get current(): ModeDefinition { return this.modes[this.index]!; }
  select(id: string): boolean {
    const index = this.modes.findIndex(mode => mode.id === id);
    if (index < 0) return false;
    this.index = index;
    return true;
  }
  /**
   * The mode Shift+Tab would land on, WITHOUT moving the cursor.
   *
   * Callers must decide whether the switch is allowed first (a running turn, or
   * children holding permissions, can refuse it) and only then apply the mode.
   * Moving the cursor here made the switch look applied while the policy was
   * never written, and `select()` could not tell the two apart any more.
   */
  next(): ModeDefinition {
    return this.modes[this.nextIndex()]!;
  }
  private nextIndex(): number {
    let next = (this.index + 1) % this.modes.length;
    while (this.modes[next]?.cycleable === false && next !== this.index) {
      next = (next + 1) % this.modes.length;
    }
    return next;
  }
  cycle(): void {
    this.index = this.nextIndex();
  }
}

/** Pi assigns onSubmit after the editor factory returns. Wrap those assignments,
 * not only Enter, so application submit paths use the same routing policy. */
export function routeSubmissions(
  editor: { onSubmit?: (text: string) => unknown },
  route: (text: string) => string,
  around?: (routed: string, submit: () => unknown) => unknown,
): void {
  let handler = editor.onSubmit;
  Object.defineProperty(editor, "onSubmit", {
    configurable: true,
    get: () => handler ? (text: string) => {
      const routed = route(text);
      const submit = () => handler!.call(editor, routed);
      return around ? around(routed, submit) : submit();
    } : undefined,
    set: (value: typeof handler) => { handler = value; },
  });
}
