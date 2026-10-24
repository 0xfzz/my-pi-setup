export interface ScopedChild {
  id: string;
  name: string;
  agent?: string;
  scope: string;
  sessionFile: string;
  paneId?: string;
  status: "running" | "completed" | "blocked" | "failed" | "closed";
  /** Audit copy of the handoff spec. Orchestrator-side evidence, never handed to the child. */
  specPath?: string;
  /** Deterministic handoff id, so a respawn of the same scope is recognisable. */
  handoffId?: string;
  laneFiles: string[];
  lastMilestoneFiles: string[];
  artifactIds?: string[];
  pendingPing?: boolean;
  task?: string;
  /** Wall-clock start, so the watchdog can enforce a budget without a timer per child. */
  startedAt?: number;
  /** Wall-clock budget in ms. Undefined = no budget (not recommended). */
  budgetMs?: number;
  /** Launch script path, so a restored child can be re-watched after a restart. */
  launchScriptFile?: string;
  /** Last observed pane tail — the watchdog's stall detector compares consecutive reads. */
  lastTail?: string | null;
  /** Consecutive identical-tail strikes. 3 strikes = stall. */
  stallStrikes?: number;
  /** Last captured token usage for the child (from the session file tail). */
  lastTokens?: number;
  lastContextWindow?: number;
  updatedAt: string;
}

export interface SteerRecord {
  id: string;
  childId: string;
  scope: string;
  origin: "user" | "orchestrator";
  mode: "interrupt" | "queue";
  message: string;
  timestamp: string;
  preTail?: string;
  /** Pane tail after delivery — observed, not assumed. */
  observedTail?: string;
  status: "delivered" | "queued-unconfirmed" | "interrupt-failed" | "not-running";
  reason?: string;
}

export interface ReviewRecord {
  id: string;
  scope: string;
  verdict: "approved" | "rejected" | "revise";
  summary: string;
  failedCriteria: string[];
  inLane: boolean;
  timestamp: string;
}

export interface RegistrySnapshot {
  version: 1;
  savedAt: string;
  children: ScopedChild[];
  steers: SteerRecord[];
  reviews: ReviewRecord[];
}

export class ScopeRegistry {
  private readonly childrenById = new Map<string, ScopedChild>();
  private readonly childrenBySession = new Map<string, ScopedChild>();
  private readonly runScopes = new Map<string, string>(); // sessionFile -> scope
  private readonly steers: SteerRecord[] = [];
  private readonly reviews: ReviewRecord[] = [];

  public registerChild(child: ScopedChild): void {
    this.childrenById.set(child.id, child);
    this.childrenBySession.set(child.sessionFile, child);
    this.runScopes.set(child.sessionFile, child.scope);
  }

  public getChildById(id: string): ScopedChild | undefined {
    return this.childrenById.get(id);
  }

  public getChildBySession(sessionFile: string): ScopedChild | undefined {
    return this.childrenBySession.get(sessionFile);
  }

  public getScopeForSession(sessionFile: string): string | undefined {
    return this.runScopes.get(sessionFile);
  }

  public updateStatus(
    sessionFile: string,
    status: ScopedChild["status"],
    details?: { pendingPing?: boolean; paneId?: string }
  ): ScopedChild | undefined {
    const child = this.childrenBySession.get(sessionFile);
    if (!child) return undefined;
    child.status = status;
    child.updatedAt = new Date().toISOString();
    if (details?.pendingPing !== undefined) {
      child.pendingPing = details.pendingPing;
    }
    if (details?.paneId) {
      child.paneId = details.paneId;
    }
    return child;
  }

  public updateMilestone(sessionFile: string, files: string[]): ScopedChild | undefined {
    const child = this.childrenBySession.get(sessionFile);
    if (!child) return undefined;
    child.lastMilestoneFiles = files;
    child.updatedAt = new Date().toISOString();
    return child;
  }

  public updateRuntime(
    sessionFile: string,
    fields: Partial<Pick<ScopedChild, "lastTail" | "stallStrikes" | "lastTokens" | "lastContextWindow">>
  ): ScopedChild | undefined {
    const child = this.childrenBySession.get(sessionFile);
    if (!child) return undefined;
    Object.assign(child, fields);
    child.updatedAt = new Date().toISOString();
    return child;
  }

  public recordSteer(steer: SteerRecord): void {
    this.steers.push(steer);
  }

  /** Newest review first. */
  public getReviews(scope?: string): ReviewRecord[] {
    const list = scope ? this.reviews.filter((r) => r.scope === scope) : [...this.reviews];
    return list.reverse();
  }

  public recordReview(review: ReviewRecord): void {
    this.reviews.push(review);
  }

  /** Number of consecutive "revise" verdicts trailing for a scope. A non-revise verdict for that scope ends the run; a review of a DIFFERENT scope does not reset the count (otherwise alternating scopes could keep a loop alive forever). */
  public getReviseRound(scope: string): number {
    let round = 0;
    for (let i = this.reviews.length - 1; i >= 0; i--) {
      const review = this.reviews[i];
      if (review.scope !== scope) continue;
      if (review.verdict !== "revise") break;
      round++;
    }
    return round;
  }

  /**
   * Exact + directory-prefix overlap check between a candidate lane and every
   * active child's lane. A whole-repo lane (a lone "**" over "*" glob) conflicts
   * with everything, which is itself worth refusing upstream.
   */
  public findLaneConflicts(candidateFiles: string[], excludeSessionFile?: string): ScopedChild[] {
    const norm = (p: string) => p.replace(/^\.?\//, "");
    const candidate = candidateFiles.map(norm);
    return this.getRunningChildren().filter((child) => {
      if (excludeSessionFile && child.sessionFile === excludeSessionFile) return false;
      return candidate.some((cLane) =>
        child.laneFiles.some((lane) => {
          const l = norm(lane);
          return l === cLane || cLane.startsWith(l + "/") || l.startsWith(cLane + "/");
        }),
      );
    });
  }

  public toSnapshot(): RegistrySnapshot {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      children: this.getAllChildren(),
      steers: [...this.steers],
      reviews: [...this.reviews],
    };
  }

  public loadSnapshot(snapshot: RegistrySnapshot): void {
    for (const child of snapshot.children ?? []) {
      this.childrenById.set(child.id, child);
      this.childrenBySession.set(child.sessionFile, child);
      this.runScopes.set(child.sessionFile, child.scope);
    }
    for (const steer of snapshot.steers ?? []) this.steers.push(steer);
    for (const review of snapshot.reviews ?? []) this.reviews.push(review);
  }

  public getSteers(childId?: string): SteerRecord[] {
    if (!childId) return [...this.steers];
    return this.steers.filter((s) => s.childId === childId);
  }

  public getRunningChildren(): ScopedChild[] {
    return Array.from(this.childrenById.values()).filter(
      (c) => c.status === "running" || c.status === "blocked"
    );
  }

  public getAllChildren(): ScopedChild[] {
    return Array.from(this.childrenById.values());
  }

  public getChildrenInScope(scope: string): ScopedChild[] {
    return Array.from(this.childrenById.values()).filter((c) => c.scope === scope);
  }

  /**
   * Resolves which child's declared lane covers the given filePath.
   * Matches if laneFiles contains the exact path, or if a directory prefix matches.
   */
  public resolveLaneForPath(filePath: string): ScopedChild[] {
    const normalized = filePath.replace(/^\.?\//, "");
    const matches: ScopedChild[] = [];

    for (const child of this.getAllChildren()) {
      for (const lane of child.laneFiles) {
        const normLane = lane.replace(/^\.?\//, "");
        if (normLane === normalized) {
          matches.push(child);
          break;
        }
        // Directory prefix match: if normLane ends with / or is a directory prefix
        const dirPrefix = normLane.endsWith("/") ? normLane : `${normLane}/`;
        if (normalized.startsWith(dirPrefix)) {
          matches.push(child);
          break;
        }
      }
    }

    return matches;
  }
}
