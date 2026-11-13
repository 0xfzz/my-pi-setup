/**
 * Per-plugin circuit breaker (PRD §6.5). Failures (throws, timeouts, schema
 * violations) inside a sliding window count toward a threshold; reaching it
 * trips the breaker, and the manager quarantines the plugin.
 */

export interface BreakerOptions {
  /** Failures inside `windowMs` that trip the breaker. */
  threshold: number;
  windowMs: number;
  clock?: () => number;
}

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly clock: () => number;
  private failures: number[] = [];
  private tripped = false;

  constructor(options: BreakerOptions) {
    if (!Number.isInteger(options.threshold) || options.threshold < 1) {
      throw new RangeError("breaker threshold must be a positive integer");
    }
    if (!(options.windowMs > 0)) throw new RangeError("breaker window must be positive");
    this.threshold = options.threshold;
    this.windowMs = options.windowMs;
    this.clock = options.clock ?? Date.now;
  }

  /** Failures still inside the window. */
  count(): number {
    const cutoff = this.clock() - this.windowMs;
    this.failures = this.failures.filter((at) => at > cutoff);
    return this.failures.length;
  }

  get isTripped(): boolean {
    return this.tripped;
  }

  /** Record one failure. Returns true exactly when this failure trips the breaker. */
  recordFailure(): boolean {
    if (this.tripped) return false;
    this.failures.push(this.clock());
    if (this.count() >= this.threshold) {
      this.tripped = true;
      return true;
    }
    return false;
  }

  /** Clearing quarantine resets the breaker; the window starts fresh. */
  reset(): void {
    this.failures = [];
    this.tripped = false;
  }
}
