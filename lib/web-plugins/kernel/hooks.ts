/**
 * Logic hook bus (PRD §5.4.2, R11). Three kinds of handler, each run under a time
 * budget and an error boundary:
 *   event     observe only; fire-and-forget; cannot change the result
 *   waterfall transform; each handler gets the previous value, returns the next
 *   bail      veto; the first handler to return { deny } stops the action
 * A handler that throws or times out is recorded and skipped; the chain continues
 * with the previous value. Registration is checked against the catalog, against
 * protected points, and against the plugin's granted capabilities.
 */
import { assertGranted, parseCapability, type Capability } from "./capabilities.ts";
import { runWithBudget } from "./budget.ts";
import { isProtectedPoint, lookupPoint, type PointKind } from "./catalog.ts";

export const DEFAULT_HOOK_BUDGET_MS = 250;

export type HookKind = "event" | "waterfall" | "bail";

const KIND_CAPABILITY: Record<HookKind, "hooks.observe" | "hooks.transform" | "hooks.veto"> = {
  event: "hooks.observe",
  waterfall: "hooks.transform",
  bail: "hooks.veto",
};

const CATALOG_KIND: Partial<Record<PointKind, HookKind>> = { event: "event", waterfall: "waterfall", bail: "bail" };

export interface HookFailure {
  pluginId: string;
  point: string;
  reason: "timeout" | "error" | "invalid";
  message: string;
}

export interface HookOwner {
  pluginId: string;
  grants: readonly Capability[];
}

interface Registration {
  id: number;
  owner: HookOwner;
  point: string;
  kind: HookKind;
  priority: number;
  handler: (...args: unknown[]) => unknown;
}

export interface HookBusOptions {
  budgetMs?: number;
  onFailure?: (failure: HookFailure) => void;
  clock?: () => number;
}

export type BailResult = { denied: false } | { denied: true; reason: string; pluginId: string };

function compareRegistrations(a: Registration, b: Registration): number {
  return b.priority - a.priority || (a.owner.pluginId < b.owner.pluginId ? -1 : a.owner.pluginId > b.owner.pluginId ? 1 : 0) || a.id - b.id;
}

export class HookBus {
  private readonly regs: Registration[] = [];
  private nextId = 1;
  private readonly budgetMs: number;
  private readonly onFailure: (failure: HookFailure) => void;
  private readonly clock: () => number;

  constructor(options: HookBusOptions = {}) {
    this.budgetMs = options.budgetMs ?? DEFAULT_HOOK_BUDGET_MS;
    this.onFailure = options.onFailure ?? (() => undefined);
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Register a handler. Throws for an unknown point (unless it sits in the plugin's own
   * namespace), a protected point, a kind that does not match the catalog, or a missing grant.
   * Returns the unregister function.
   */
  register(owner: HookOwner, kind: HookKind, point: string, handler: (...args: unknown[]) => unknown, priority = 0): () => void {
    if (isProtectedPoint(point)) {
      throw new Error(`Plugin "${owner.pluginId}": "${point}" is a protected point and cannot be hooked`);
    }
    const own = point.startsWith(`${owner.pluginId}.`);
    if (!own) {
      const found = lookupPoint(point);
      if (!found.ok) throw new Error(`Plugin "${owner.pluginId}": ${found.error}`);
      const catalogKind = CATALOG_KIND[found.point.kind];
      if (catalogKind !== kind) {
        throw new Error(`Plugin "${owner.pluginId}": "${point}" is a ${found.point.kind} point, not a ${kind} hook`);
      }
    }
    const requested = parseCapability(`${KIND_CAPABILITY[kind]}:${point}`);
    if (!requested.ok) throw new Error(`Plugin "${owner.pluginId}": ${requested.error}`);
    if (!own) assertGranted(owner.pluginId, owner.grants, requested.value);
    const reg: Registration = { id: this.nextId++, owner, point, kind, priority, handler };
    this.regs.push(reg);
    return () => {
      const index = this.regs.indexOf(reg);
      if (index !== -1) this.regs.splice(index, 1);
    };
  }

  /** Handlers that would run for a point, in run order. */
  handlersFor(point: string): Array<{ pluginId: string; kind: HookKind; priority: number }> {
    return this.regs
      .filter((r) => r.point === point)
      .sort(compareRegistrations)
      .map((r) => ({ pluginId: r.owner.pluginId, kind: r.kind, priority: r.priority }));
  }

  /** Observe. Every handler runs with its budget; nothing it does can change the caller's result. */
  async event(point: string, payload: unknown): Promise<void> {
    const list = this.runnable(point, "event");
    await Promise.all(list.map((reg) => this.invoke(reg, [payload])));
  }

  /** Transform. A handler returning undefined keeps the previous value. */
  async waterfall<T>(point: string, value: T, info: unknown): Promise<T> {
    let current = value;
    for (const reg of this.runnable(point, "waterfall")) {
      const outcome = await this.invoke(reg, [current, info]);
      if (outcome !== undefined) current = outcome as T;
    }
    return current;
  }

  /** Veto. The first handler that returns `{ deny: reason }` stops the action. */
  async bail(point: string, payload: unknown): Promise<BailResult> {
    for (const reg of this.runnable(point, "bail")) {
      const outcome = await this.invoke(reg, [payload]);
      if (outcome && typeof outcome === "object" && typeof (outcome as { deny?: unknown }).deny === "string") {
        return { denied: true, reason: (outcome as { deny: string }).deny, pluginId: reg.owner.pluginId };
      }
    }
    return { denied: false };
  }

  /** Remove every registration a plugin made (on deactivate, rollback, or quarantine). */
  removeOwner(pluginId: string): number {
    const before = this.regs.length;
    for (let i = this.regs.length - 1; i >= 0; i--) {
      if (this.regs[i].owner.pluginId === pluginId) this.regs.splice(i, 1);
    }
    return before - this.regs.length;
  }

  private runnable(point: string, kind: HookKind): Registration[] {
    return this.regs.filter((r) => r.point === point && r.kind === kind).sort(compareRegistrations);
  }

  private async invoke(reg: Registration, args: unknown[]): Promise<unknown> {
    const label = `${reg.owner.pluginId} ${reg.kind} ${reg.point}`;
    const outcome = await runWithBudget(label, this.budgetMs, () => reg.handler(...args), this.clock);
    if (outcome.ok) return outcome.value;
    this.onFailure({ pluginId: reg.owner.pluginId, point: reg.point, reason: outcome.reason, message: outcome.error });
    return undefined;
  }
}
