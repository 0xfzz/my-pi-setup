/**
 * The pi_api module registry — lifecycle owner for the api modules.
 *
 * - `register` plugs a module in (idempotent per api name).
 * - `dispatch` lazily initializes on first use, then forwards.
 * - `dispose` tears every module down when the host detaches.
 *
 * Errors never throw out of `dispatch`: an api failure becomes a failed
 * response the web client can render, not a broken bridge.
 */
import type { PiApiContext, PiApiHandlerResult, PiApiModule } from "./types.ts";

export interface PiApiRegistry {
  register(module: PiApiModule): void;
  dispatch(api: string, params: unknown, ctx: PiApiContext): Promise<PiApiHandlerResult>;
  /** Every module's dispose, regardless of init state. */
  dispose(): Promise<void>;
}

export function createPiApiRegistry(): PiApiRegistry {
  const modules = new Map<string, PiApiModule>();
  const initialized = new Set<PiApiModule>();

  return {
    register(module: PiApiModule): void {
      modules.set(module.api, module);
    },

    async dispatch(api: string, params: unknown, ctx: PiApiContext): Promise<PiApiHandlerResult> {
      const module = modules.get(api);
      if (module === undefined) {
        return { ok: false, error: `unknown pi api: ${api}` };
      }
      try {
        if (module.init !== undefined && !initialized.has(module)) {
          await module.init(ctx);
          initialized.add(module);
        }
        return { ok: true, result: await module.handle(params, ctx) };
      } catch (error) {
        return { ok: false, error: `pi api ${api} failed: ${stringifyError(error)}` };
      }
    },

    async dispose(): Promise<void> {
      for (const module of modules.values()) {
        try {
          await module.dispose?.();
        } catch {
          // A failing dispose must not block the rest of teardown.
        }
        initialized.delete(module);
      }
    },
  };
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
