/**
 * `trust.read` / `trust.write` — pi's project-trust store, called natively.
 *
 * The web /trust port: the same options pi's TUI trust selector offers
 * (trust this folder, trust the parent folder, do not trust), read through
 * `getProjectTrustOptions` and written through `ProjectTrustStore.setMany`.
 * The web never derives its own trust list — pi's own trust-manager does.
 *
 * A written decision lands in pi's trust store (a file under the agent dir,
 * keyed by path) and takes effect on the next session start, exactly like
 * the TUI's "Restart pi for this to take effect" note.
 */
import type { PiApiContext, PiApiModule } from "./types.ts";

/** pi's trust-manager shapes, structural (deep module re-exported by the package). */
interface TrustUpdate {
  path: string;
  decision: boolean | null;
}
interface TrustOption {
  label: string;
  trusted: boolean;
  updates: TrustUpdate[];
  savedPath?: string;
}
interface TrustStoreEntry {
  path: string;
  decision: boolean;
}
interface TrustStore {
  getEntry(cwd: string): TrustStoreEntry | null;
  setMany(updates: TrustUpdate[]): void;
}

async function loadTrust(cwd: string): Promise<{ store: TrustStore; options: TrustOption[] }> {
  const [{ getAgentDir }, trustManager] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("../../node_modules/@earendil-works/pi-coding-agent/dist/core/trust-manager.js"),
  ]);
  const store = new (trustManager as { ProjectTrustStore: new (agentDir: string) => TrustStore }).ProjectTrustStore(
    getAgentDir(),
  );
  return {
    store,
    options: (trustManager as { getProjectTrustOptions(cwd: string): TrustOption[] }).getProjectTrustOptions(cwd),
  };
}

export const trustApi: PiApiModule = {
  api: "trust.read",

  async handle(_params: unknown, ctx: PiApiContext): Promise<unknown> {
    const { store, options } = await loadTrust(ctx.cwd);
    const savedDecision = store.getEntry(ctx.cwd);
    return {
      cwd: ctx.cwd,
      savedDecision,
      options: options.map((option) => ({
        label: option.label,
        trusted: option.trusted,
        ...(option.savedPath !== undefined ? { savedPath: option.savedPath } : {}),
      })),
    };
  },
};

export const trustWriteApi: PiApiModule = {
  api: "trust.write",

  async handle(params: unknown, ctx: PiApiContext): Promise<unknown> {
    const { label } = (params as { label?: unknown } | null ?? {}) as { label?: unknown };
    if (typeof label !== "string" || label.trim() === "") {
      throw new Error("params: {label: string}");
    }
    const { store, options } = await loadTrust(ctx.cwd);
    // The client only sends a label it received from trust.read; re-derive
    // pi's option list and match by label so an arbitrary label cannot
    // invent a path or decision pi never offered.
    const option = options.find((candidate) => candidate.label === label.trim());
    if (option === undefined) throw new Error("unknown trust option");
    store.setMany(option.updates);
    const savedDecision = store.getEntry(ctx.cwd);
    return { savedDecision };
  },
};