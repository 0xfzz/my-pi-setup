/** Kernel-side view of a discovered browser entry. Absolute dir stays internal. */
export interface BrowserHalfSource {
  readonly id: string;
  readonly version: string;
  readonly source: string;
  readonly dir: string;
  readonly sourcePath: string;
  readonly capabilities: readonly string[];
  readonly trust: string;
}
