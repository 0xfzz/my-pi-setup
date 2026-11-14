/**
 * Type declarations for the pure motion planner. The canonical module is
 * `motion.mjs` (no DOM, no timers); `app.mjs` consumes its plan and the CSS in
 * `style.css` performs the animation.
 */

export interface GraphMotionPlan {
  /** The SVG must be re-rendered (topology changed) and its viewBox tweened. */
  relayout: boolean;
  /** Node ids that should enter with a staggered reveal. */
  entering: string[];
  /** Edge ids that should draw themselves in. */
  edgesToDraw: string[];
  /** Node ids whose status changed to a finished state (600ms flash). */
  updated: string[];
  /** Node ids whose status changed but should switch instantly. */
  instants: string[];
  /** True when the host asked for reduced motion; every list is empty. */
  reducedMotion: boolean;
}

export interface MotionOptions {
  reducedMotion?: boolean;
}

export declare const MOTION: Readonly<{
  relayoutMs: number;
  entryMs: number;
  staggerStepMs: number;
  maxStagger: number;
  edgeDrawMs: number;
  statusFlashMs: number;
  ambientMs: number;
  activeEdgeMs: number;
}>;

export declare function planGraphMotion(
  prev: any,
  next: any,
  options?: MotionOptions,
): GraphMotionPlan;

export declare function staggerDelayMs(index: number, step?: number): number;
export declare function prefersReducedMotion(host?: any): boolean;
