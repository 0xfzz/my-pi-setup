import { lanesOverlap, normalizePath } from "./lane.ts";

/**
 * Why a child stopped. Present iff its status is terminal, so an audit can tell
 * a deliberate close from a crash without inferring it from pane liveness.
 */
export type CloseReason =
  | "interrupted"
  | "interrupt-failed"
  | "review-approved"
  | "review-rejected"
  | "pane-gone"
  | "user-closed"
  | "watchdog-close"
  | "watcher-error"
  | "auto-close-terminal"
  | "resume-superseded"
  | "scope-cancelled"
  /** Closed while suspended, intact so its run can be redeployed later. */
  | "paused"
  /** Paused, but its session file is gone: nothing left to redeploy. */
  | "paused-missing";

/**
 * Watchdog bookkeeping, persisted with the child.
 *
 * `trip` is the anti-storm guard: once a child has tripped for a reason, the
 * same reason never notifies again. Without it the budget branch re-fired every
 * 30s tick forever (observed live: 10+ notices for one child in five minutes,
 * each with `elapsedMs` growing by exactly one interval).
 */
export interface WatchdogState {
  trip: "budget-exceeded" | "stall-detected" | "close-failed" | null;
  trippedAt?: string;
  notifiedAt?: string;
  interruptSentAt?: string;
  interrupts: number;
  /** Failed Escape deliveries; the watchdog ends the child after MAX attempts. */
  interruptFailures?: number;
  /** Why the last automatic close attempt failed, so the retry is diagnosable. */
  lastFailure?: string;
}

export interface ResultDisposition {
  disposition: "accepted" | "changes-requested" | "abandoned";
  resultRevision: number;
  summary: string;
  evidence: string[];
  integration: string;
  /**
   * What was wrong, in the handoff's own terms.
   *
   * Required for `changes-requested`: a rework is spawned against the frozen
   * original handoff plus this list, so "it did not match" has to name which
   * criterion and how. Empty here would make the rework a fresh spawn that
   * forgot the first brief, which is the failure this field exists to prevent.
   */
  defects?: string[];
  at: string;
}

export interface ChildAccountability {
  ownerSessionId: string;
  batchId: string;
  workUnitKey: string;
  delegationReason: string;
  reviewPlan: string;
  resultRevision: number;
  disposition: "pending" | ResultDisposition["disposition"];
  /**
   * How many reworks this work unit has cost, starting at 0.
   *
   * A rework is the same work unit, not a new one, so the count lives here and
   * the ceiling is enforced at spawn time: past the cap the decision belongs to
   * the user, not to another round of the same loop.
   */
  reworkRound?: number;
  reviews: ResultDisposition[];
  /** Prior attempts survive resume, including the decisions made on them. */
  attempts: Array<{ id: string; resultRevision: number; reviews: ResultDisposition[] }>;
}

export interface DelegationBatch {
  id: string;
  ownerSessionId: string;
  generation: number;
  launches: number;
}

export interface ScopedChild {
  id: string;
  name: string;
  agent?: string;
  scope: string;
  sessionFile: string;
  /**
   * What this child exists to do.
   *
   * Reviewers are readers of a pinned document, not writers of a lane, so they are
   * registered with `laneFiles: []`. Keeping the purpose explicit is what lets
   * steering, review, and status report the right thing instead of treating a
   * missing lane as a malformed worker. Research and ad-hoc children also have no
   * lane by default; their purpose says so instead of inventing one.
   */
  purpose?: "implementation" | "review" | "research" | "adhoc";
  /** Review metadata. Present iff `purpose` is `review`. */
  reviewRunId?: string;
  reviewLens?: string;
  targetHash?: string;
  paneId?: string;
  /** PID of the parent process that spawned this child, for the per-process cap. */
  parentPid?: number;
  /** Absent on legacy rows: legacy/unreviewed, never implicitly accepted. */
  accountability?: ChildAccountability;
  status: "running" | "completed" | "blocked" | "failed" | "closed";
  /** Audit copy of the handoff spec. Parent-side evidence, never handed to the child. */
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
  /**
   * mtime of the session file at the last tick.
   *
   * A child that is running a long suite prints nothing new to its pane, so tail
   * identity alone is not evidence of a stall — but its session file keeps being
   * written. Activity here resets the strike counter.
   */
  lastSessionActivity?: number;
  /** Last captured token usage for the child (from the session file tail). */
  lastTokens?: number;
  lastContextWindow?: number;
  /** Watchdog trip state — persisted so a restart cannot replay a notice. */
  watchdog?: WatchdogState;
  /** How the child ended; present iff status is terminal. */
  closedAt?: string;
  closeReason?: CloseReason;
  /** Ids this row superseded (resume history), so an audit can follow the chain. */
  supersededIds?: string[];
  /** Launch shape, persisted so a child restored after a restart can be re-watched. */
  interactive?: boolean;
  autoExit?: boolean;
  /**
   * The acceptance criteria as they existed when this child was spawned.
   *
   * A review judges these, not the current handoff: re-authoring a spec after the
   * child ran used to rewrite the criteria the verdict was measured against, so a
   * failing criterion could be edited out and the approval would be "consistent".
   */
  frozenCriteria?: string[];
  /** Handoff revision at spawn, so a later revision is visible in the review. */
  handoffRevision?: number;
  /** When the criteria above were captured. */
  specFrozenAt?: string;
  updatedAt: string;
}

/**
 * A write the parent itself made through `write`/`edit`.
 *
 * Independence is a fact about who touched the lane, so it is recorded rather
 * than asserted. `bash` is not recorded here on purpose: a shell command can
 * write anywhere, and pretending a path list proves otherwise would be worse
 * than saying so. The computed diff is the load-bearing evidence; this log is
 * the exact part.
 */
export interface AuthorWrite {
  path: string;
  tool: string;
  at: string;
}

export interface SteerRecord {
  id: string;
  childId: string;
  scope: string;
  origin: "user" | "parent";
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
  /**
   * Whether this answer can be trusted as an independent read of the work.
   *
   * `shell-unverified` is the honest third state: the parent may run bash,
   * and a shell can write anywhere, so a scope reviewed after shell activity has
   * no provable independence claim even when no write/edit tool was used.
   */
  independence?: "clean" | "self-authored" | "shell-unverified";
  /** True when the evidence was verified against the repository, not just quoted. */
  verified?: boolean;
  /** Where "in lane" came from: computed from git, or declared by the model. */
  laneSource?: "git" | "declared";
  /** How many evidence references the gate actually checked. */
  evidenceRefs?: number;
  /** The user was asked to overrule an `self-authored` scope. */
  userConfirmed?: boolean;
  /** Handoff revision the review judged (the frozen one). */
  specRevision?: number;
  /** Tokens its children spent on this work unit, when the sessions reported any. */
  tokens?: number;
  /** Check receipt this verdict relied on, when one was cited. */
  checkRunId?: string;
  /**
   * Provenance note for the verdict, e.g. "no receipt cited — evidence is
   * attested". Recorded so an attested approval is distinguishable from a
   * receipt-backed one in the audit trail.
   */
  note?: string;
  /** Non-fatal findings, e.g. "handoff was revised after spawn". */
  findings?: string[];
}

export interface RegistrySnapshot {
  version: 1;
  savedAt: string;
  delegationBatch?: DelegationBatch;
  children: ScopedChild[];
  steers: SteerRecord[];
  reviews: ReviewRecord[];
  /** Every pane this parent ever opened, so orphans stay attributable. */
  panes?: string[];
  /** Retained for sidecar compatibility with sessions written before the
   *  pause commands were removed; nothing sets it any more. */
  paused?: boolean;
  /** Writes the parent made itself, used to compute review independence. */
  authorWrites?: AuthorWrite[];
  /** Shell invocations by the parent, which can write without naming a path. */
  authorShells?: string[];
}

export class ScopeRegistry {
  private batch?: DelegationBatch;
  private readonly childrenById = new Map<string, ScopedChild>();
  private readonly childrenBySession = new Map<string, ScopedChild>();
  private readonly runScopes = new Map<string, string>(); // sessionFile -> scope
  private readonly steers: SteerRecord[] = [];
  private readonly reviews: ReviewRecord[] = [];
  /** Pane ids opened by this parent. Attribution for the orphan sweep: a pane we
   * cannot prove we started is never closed. */
  private readonly knownPanes = new Set<string>();
  /** Survives a restart with the sidecar, so a paused run does not silently reopen. */
  private paused = false;
  /** Bounded: independence only needs the recent history of a live scope. */
  private readonly authorWrites: AuthorWrite[] = [];
  /** Timestamps of parent shell calls: a shell can write without naming a path. */
  private readonly authorShells: string[] = [];

  /**
   * Insert a child, keeping exactly ONE live row per session file.
   *
   * `agent_resume` mints a new id for an existing session file. The old code
   * inserted the new row and left the old one in `childrenById` as a permanent
   * "running" ghost that only the newest row's status updates could reach —
   * which is how one child produced budget notices quoting three different ids
   * and two different budgets. The superseded rows are returned so the caller
   * can abort their watchers before installing the new one.
   */
  public registerChild(child: ScopedChild): ScopedChild[] {
    const superseded: ScopedChild[] = [];
    for (const [id, existing] of this.childrenById) {
      if (id === child.id || existing.sessionFile !== child.sessionFile) continue;
      if (existing.accountability) {
        child.accountability = {
          ...existing.accountability,
          resultRevision: existing.accountability.resultRevision + 1,
          disposition: "pending",
          reviews: [],
          attempts: [...existing.accountability.attempts, {
            id: existing.id,
            resultRevision: existing.accountability.resultRevision,
            reviews: [...existing.accountability.reviews],
          }],
        };
      }
      existing.status = "closed";
      existing.pendingPing = false;
      existing.closedAt = new Date().toISOString();
      existing.closeReason = "resume-superseded";
      existing.stallStrikes = 0;
      existing.watchdog = { trip: null, interrupts: existing.watchdog?.interrupts ?? 0 };
      superseded.push(existing);
      this.childrenById.delete(id);
      child.supersededIds = [...(child.supersededIds ?? []), id];
    }
    this.childrenById.set(child.id, child);
    this.childrenBySession.set(child.sessionFile, child);
    this.runScopes.set(child.sessionFile, child.scope);
    return superseded;
  }

  public getChildById(id: string): ScopedChild | undefined {
    return this.childrenById.get(id);
  }

  public getChildBySession(sessionFile: string): ScopedChild | undefined {
    return this.childrenBySession.get(sessionFile);
  }

  /**
   * Drop every row that belongs to a session.
   *
   * The registry is a module singleton, and Pi replaces a session *inside* the
   * same process (`/new`, `/resume`, `/fork`): `session_shutdown` persists the old
   * session, then `session_start` fires again with a new id and the same module
   * instance. Without this reset the new session adopted the previous session's
   * children (observed: a fresh session showed three subagents from the run it
   * replaced) and wrote them into its own sidecar on the first persist.
   */
  public reset(): void {
    this.batch = undefined;
    this.childrenById.clear();
    this.childrenBySession.clear();
    this.runScopes.clear();
    this.steers.length = 0;
    this.reviews.length = 0;
    this.knownPanes.clear();
    this.paused = false;
    this.authorWrites.length = 0;
    this.authorShells.length = 0;
  }

  /** Test seam only: the registry is a module singleton shared by one file's cases. */
  public resetForTests(): void {
    this.reset();
  }

  public recordAuthorWrite(write: AuthorWrite): void {
    this.authorWrites.push(write);
    if (this.authorWrites.length > 500) this.authorWrites.splice(0, this.authorWrites.length - 500);
  }

  /** Writes at or after `sinceIso` (inclusive), optionally filtered to one path. */
  public getAuthorWrites(sinceIso?: string, path?: string): AuthorWrite[] {
    return this.authorWrites.filter((w) =>
      (!sinceIso || w.at >= sinceIso) && (!path || w.path === path),
    );
  }

  /**
   * Record that the parent ran a shell command.
   *
   * No path is recorded because a shell does not have to name one: that is the
   * point. The fact is enough to deny a "clean" independence claim, which is
   * what the review gate needs and all it can honestly conclude.
   */
  public recordAuthorShell(at: string = new Date().toISOString()): void {
    this.authorShells.push(at);
    if (this.authorShells.length > 500) this.authorShells.splice(0, this.authorShells.length - 500);
  }

  /** Shell invocations at or after `sinceIso` (inclusive). */
  public getAuthorShells(sinceIso?: string): string[] {
    return this.authorShells.filter((at) => !sinceIso || at >= sinceIso);
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
    if (child.status !== status && status !== "running" && status !== "blocked") {
      this.invalidateResult(child);
    }
    child.status = status;
    child.updatedAt = new Date().toISOString();
    if (details?.pendingPing !== undefined) {
      child.pendingPing = details.pendingPing;
    }
    if (details?.paneId) {
      child.paneId = details.paneId;
    }
    if (status === "closed" && !child.closedAt) {
      child.closedAt = child.updatedAt;
      child.closeReason = child.closeReason ?? "scope-cancelled";
      child.stallStrikes = 0;
      child.watchdog = { trip: null, interrupts: child.watchdog?.interrupts ?? 0 };
    }
    return child;
  }

  public updateMilestone(sessionFile: string, files: string[]): ScopedChild | undefined {
    const child = this.childrenBySession.get(sessionFile);
    if (!child) return undefined;
    if (child.status !== "running" && child.status !== "blocked") this.invalidateResult(child);
    child.lastMilestoneFiles = files;
    child.updatedAt = new Date().toISOString();
    return child;
  }

  public updateRuntime(
    sessionFile: string,
    fields: Partial<Pick<ScopedChild, "lastTail" | "stallStrikes" | "lastTokens" | "lastContextWindow" | "lastSessionActivity">>
  ): ScopedChild | undefined {
    const child = this.childrenBySession.get(sessionFile);
    if (!child) return undefined;
    Object.assign(child, fields);
    child.updatedAt = new Date().toISOString();
    return child;
  }

  /** Merge watchdog bookkeeping. `addInterrupt` counts a delivered Escape. */
  public updateWatchdog(
    sessionFile: string,
    patch: Partial<WatchdogState> & { addInterrupt?: boolean }
  ): ScopedChild | undefined {
    const child = this.childrenBySession.get(sessionFile);
    if (!child) return undefined;
    const { addInterrupt, ...rest } = patch;
    const current = child.watchdog ?? { trip: null, interrupts: 0 };
    child.watchdog = { ...current, ...rest };
    if (addInterrupt) child.watchdog.interrupts = (child.watchdog.interrupts ?? 0) + 1;
    child.updatedAt = new Date().toISOString();
    return child;
  }

  /**
   * Terminal transition. Closing is idempotent: closing an already-closed row
   * keeps the first, truthful reason instead of overwriting it later.
   */
  public closeChild(sessionFile: string, reason: CloseReason): ScopedChild | undefined {
    const child = this.childrenBySession.get(sessionFile);
    if (!child) return undefined;
    if (child.status === "closed") return child;
    // Pane cleanup after a terminal report must not invalidate its reviewed result.
    if (child.status === "running" || child.status === "blocked") this.invalidateResult(child);
    child.status = "closed";
    child.pendingPing = false;
    child.stallStrikes = 0;
    child.closedAt = new Date().toISOString();
    child.closeReason = reason;
    child.watchdog = { trip: null, interrupts: child.watchdog?.interrupts ?? 0 };
    child.updatedAt = child.closedAt;
    return child;
  }

  /** Re-arm the budget clock and clear the trip after a resume. */
  public resetWatchdog(
    sessionFile: string,
    opts?: { budgetMs?: number; startedAt?: number; status?: "running" }
  ): ScopedChild | undefined {
    const child = this.childrenBySession.get(sessionFile);
    if (!child) return undefined;
    this.invalidateResult(child);
    child.watchdog = { trip: null, interrupts: 0 };
    child.stallStrikes = 0;
    child.lastTail = null;
    child.startedAt = opts?.startedAt ?? Date.now();
    if (opts?.budgetMs) child.budgetMs = opts.budgetMs;
    child.status = opts?.status ?? "running";
    child.pendingPing = false;
    child.closedAt = undefined;
    child.closeReason = undefined;
    child.updatedAt = new Date().toISOString();
    return child;
  }

  /**
   * A paused row whose conversation is gone can never be redeployed.
   *
   * `closeChild` is idempotent and keeps the first reason, so this is the one
   * transition allowed to rewrite a closed row's reason — from `paused` to
   * `paused-missing`, never the other way.
   */
  public markPausedMissing(sessionFile: string): ScopedChild | undefined {
    const child = this.childrenBySession.get(sessionFile);
    if (!child || child.closeReason !== "paused") return child;
    child.closeReason = "paused-missing";
    child.updatedAt = new Date().toISOString();
    return child;
  }

  public recordSteer(steer: SteerRecord): void {
    this.steers.push(steer);
  }

  /**
   * A terminal row whose pane was still alive was swept. The outcome stays
   * (`completed`/`failed`), only the residue is recorded — rewriting it to
   * `closed` would erase how the child actually ended.
   */
  public markPaneSwept(sessionFile: string, reason: CloseReason): ScopedChild | undefined {
    const child = this.childrenBySession.get(sessionFile);
    if (!child) return undefined;
    child.closeReason = child.closeReason ?? reason;
    child.closedAt = child.closedAt ?? new Date().toISOString();
    child.updatedAt = new Date().toISOString();
    return child;
  }

  /**
   * Keep a live pane covered after a failed terminal transition.
   *
   * A row that stays `blocked` while its pane is alive is invisible to the
   * watchdog (which only feeds `running`), so a failed close used to park a live
   * agent forever. Re-arming `running` with a `close-failed` trip makes the next
   * tick retry the close instead of forgetting the child.
   */
  public rearmForRetry(
    sessionFile: string,
    reason: string,
    at: string = new Date().toISOString()
  ): ScopedChild | undefined {
    const child = this.childrenBySession.get(sessionFile);
    if (!child) return undefined;
    if (child.status === "closed") return child;
    child.status = "running";
    child.pendingPing = false;
    child.watchdog = {
      ...(child.watchdog ?? { interrupts: 0 }),
      trip: "close-failed",
      // Caller-supplied so retry backoff uses the same clock as the watchdog;
      // a wall-clock stamp against an injected `now()` never expires.
      trippedAt: at,
      lastFailure: reason,
    };
    child.updatedAt = new Date().toISOString();
    return child;
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
   * Overlap between a candidate lane and every active child's lane.
   *
   * Uses the SAME matcher as the review gate (`lanesOverlap` -> `laneCoversPath`),
   * so a glob that covers a file at review time also conflicts at admission time.
   * Two implementations is how a lane became disjoint at spawn and overlapping at
   * review, which is the one disagreement that silently produces two writers.
   */
  public findLaneConflicts(candidateFiles: string[], excludeSessionFile?: string): ScopedChild[] {
    const candidate = candidateFiles.map(normalizePath).filter(Boolean);
    return this.getActiveChildren().filter((child) => {
      if (excludeSessionFile && child.sessionFile === excludeSessionFile) return false;
      return candidate.some((cLane) => child.laneFiles.some((lane) => lanesOverlap(cLane, lane)));
    });
  }

  private invalidateResult(child: ScopedChild): void {
    if (!child.accountability) return;
    child.accountability.resultRevision++;
    child.accountability.disposition = "pending";
  }

  /** Legacy rows consume live capacity but do not create a retroactive review backlog. */
  public getOccupiedChildren(ownerSessionId?: string): ScopedChild[] {
    return this.getAllChildren().filter((child) => {
      const a = child.accountability;
      if (a && ownerSessionId && a.ownerSessionId !== ownerSessionId) return false;
      return child.status === "running" || child.status === "blocked"
        || (a !== undefined && (a.disposition === "pending" || a.disposition === "changes-requested"));
    });
  }

  public getPendingResults(ownerSessionId?: string): ScopedChild[] {
    return this.getOccupiedChildren(ownerSessionId).filter((child) =>
      child.accountability && child.status !== "running" && child.status !== "blocked"
      && child.accountability.disposition === "pending");
  }

  public getBatch(ownerSessionId: string): DelegationBatch {
    if (!this.batch || this.batch.ownerSessionId !== ownerSessionId) {
      this.batch = { id: `${ownerSessionId}:1`, ownerSessionId, generation: 1, launches: 0 };
    }
    return { ...this.batch };
  }

  public recordLaunch(ownerSessionId: string): void {
    this.getBatch(ownerSessionId);
    this.batch!.launches++;
  }

  /** User command only. Unresolved child ownership deliberately remains intact. */
  public newBatch(ownerSessionId: string): DelegationBatch {
    const previous = this.getBatch(ownerSessionId);
    this.batch = {
      id: `${ownerSessionId}:${previous.generation + 1}`,
      ownerSessionId, generation: previous.generation + 1, launches: 0,
    };
    return { ...this.batch };
  }

  /** Identity/revision gate shared by the tool and tests. Evidence is checked by the tool. */
  public recordDisposition(
    ownerSessionId: string, childId: string, decision: Omit<ResultDisposition, "at">,
  ): ScopedChild {
    const child = this.getChildById(childId);
    if (!child?.accountability || child.accountability.ownerSessionId !== ownerSessionId) {
      // A superseded attempt is unknown by id, but its successor still carries
      // it in the attempt trail — name that case a stale verdict instead of a
      // lookup miss, so the parent learns WHICH refusal applies.
      const superseded = [...this.childrenById.values()].some((row) =>
        row.accountability?.attempts.some((attempt) => attempt.id === childId));
      throw new Error(superseded
        ? "Stale result revision: that attempt was superseded; verdicts bind to the current row's revision."
        : "Unknown child attempt or wrong parent owner (legacy rows cannot be accepted).");
    }
    if (child.status === "running" || child.status === "blocked") throw new Error("Child is still active.");
    if (decision.resultRevision !== child.accountability.resultRevision) throw new Error("Stale result revision.");
    if (!decision.summary.trim() || !decision.integration.trim()) throw new Error("Summary and integration/cleanup notes are required.");
    if (decision.disposition === "accepted" && !decision.evidence.length) throw new Error("Acceptance requires checked evidence.");
    // A change request IS the brief for the next round. Without the defect list
    // the rework would be a fresh spawn that never saw the first handoff.
    if (decision.disposition === "changes-requested" && !(decision.defects ?? []).length) {
      throw new Error(
        "changes-requested requires at least one defect: name the acceptance criterion that was not met and what you observed. "
        + "That list is what the rework is spawned against.",
      );
    }
    const previous = child.accountability.reviews.at(-1);
    if (previous && JSON.stringify({ ...previous, at: undefined }) === JSON.stringify({ ...decision, at: undefined })) return child;
    if (child.accountability.disposition === "accepted" || child.accountability.disposition === "abandoned") {
      throw new Error("Result already settled; resume or invalidate it before reviewing again.");
    }
    child.accountability.disposition = decision.disposition;
    child.accountability.reviews.push({ ...decision, at: new Date().toISOString() });
    child.updatedAt = new Date().toISOString();
    return child;
  }

  public toSnapshot(): RegistrySnapshot {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      delegationBatch: this.batch ? { ...this.batch } : undefined,
      children: this.getAllChildren(),
      steers: [...this.steers],
      reviews: [...this.reviews],
      panes: [...this.knownPanes],
      paused: this.paused,
      authorWrites: [...this.authorWrites],
      authorShells: [...this.authorShells],
    };
  }

  /**
   * Restore, keeping ONE row per session file (the newest).
   *
   * Older sidecars contain the ghost rows described in `registerChild`; loading
   * them verbatim resurrected every one of them on the next start.
   */
  public loadSnapshot(snapshot: RegistrySnapshot): void {
    this.batch = snapshot.delegationBatch ? { ...snapshot.delegationBatch } : undefined;
    this.paused = snapshot.paused === true;
    this.authorWrites.length = 0;
    this.authorShells.length = 0;
    for (const write of snapshot.authorWrites ?? []) {
      if (write?.path && write?.at) this.authorWrites.push(write);
    }
    for (const at of snapshot.authorShells ?? []) {
      if (typeof at === "string" && at) this.authorShells.push(at);
    }
    const newest = new Map<string, ScopedChild>();
    for (const child of snapshot.children ?? []) {
      const current = newest.get(child.sessionFile);
      if (!current) {
        newest.set(child.sessionFile, child);
        continue;
      }
      const keep = (child.updatedAt ?? "") >= (current.updatedAt ?? "") ? child : current;
      const drop = keep === child ? current : child;
      keep.supersededIds = [...(keep.supersededIds ?? []), ...(drop.supersededIds ?? []), drop.id]
        .filter((id, index, all) => all.indexOf(id) === index && id !== keep.id);
      if (drop.status !== "closed") {
        drop.status = "closed";
        drop.closeReason = drop.closeReason ?? "resume-superseded";
        drop.closedAt = drop.closedAt ?? new Date().toISOString();
      }
      newest.set(child.sessionFile, keep);
    }
    for (const child of newest.values()) {
      this.childrenById.set(child.id, child);
      this.childrenBySession.set(child.sessionFile, child);
      this.runScopes.set(child.sessionFile, child.scope);
    }
    for (const steer of snapshot.steers ?? []) this.steers.push(steer);
    for (const review of snapshot.reviews ?? []) this.reviews.push(review);
    for (const pane of snapshot.panes ?? []) this.knownPanes.add(pane);
  }

  /** Remember a pane this parent opened, so the orphan sweep can attribute it. */
  public recordPane(paneId: string | undefined): void {
    if (paneId) this.knownPanes.add(paneId);
  }

  public forgetPane(paneId: string): void {
    this.knownPanes.delete(paneId);
  }

  public getKnownPanes(): string[] {
    return [...this.knownPanes];
  }

  public getSteers(childId?: string): SteerRecord[] {
    if (!childId) return [...this.steers];
    return this.steers.filter((s) => s.childId === childId);
  }

  /**
   * Children that a parent can still address: running, plus ping-paused ones
   * (a blocked child is how a child waits for an answer, so it is not gone).
   */
  public getRunningChildren(): ScopedChild[] {
    return this.getActiveChildren();
  }

  public getActiveChildren(): ScopedChild[] {
    return Array.from(this.childrenById.values()).filter(
      (c) => c.status === "running" || c.status === "blocked"
    );
  }

  /**
   * The watchdog's input: only children that still own a live turn.
   *
   * A tripped child is `blocked` and awaiting a parent decision, and a
   * ping-paused child has already exited its pane on purpose. Feeding either
   * back into the budget/stall loop is what made the watchdog repeat forever.
   */
  public getWatchdogChildren(): ScopedChild[] {
    return Array.from(this.childrenById.values()).filter(
      (c) => c.status === "running" && !c.pendingPing
    );
  }

  public getAllChildren(): ScopedChild[] {
    return Array.from(this.childrenById.values());
  }

  /** Rows that claim to be finished but may still own a pane (sweep input). */
  public getTerminalChildren(): ScopedChild[] {
    return Array.from(this.childrenById.values()).filter(
      (c) => c.status === "completed" || c.status === "failed"
    );
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
