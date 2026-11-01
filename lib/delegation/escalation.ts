/**
 * escalation.ts — the "I am unsure" ladder: child → parent → user.
 *
 * The rule this module encodes, and the reason it is a state machine instead of
 * prose in a prompt:
 *
 *   A child that does not know asks. A parent that does not know asks the
 *   user. Nobody invents an answer, and a cancelled dialog is never consent.
 *
 * The failure this replaces had two shapes. A child with no declared escalation
 * route resolved its own ambiguity by picking the interpretation that let it
 * continue. And "the parent did not answer" was indistinguishable from "the
 * parent said yes", so a paused child could be resumed with a fabricated
 * decision. Both are silent: the child reports success, and the defect surfaces
 * later as a wrong implementation nobody can trace to a decision.
 *
 * Pure: no I/O, no pane access, no clock reads beyond an injectable seam, so the
 * ladder can be exhaustively tested.
 */

/** Branch custom-entry type recording an escalation's stage transitions. */
export const ESCALATION_TYPE = "subagent-escalation:v1";

export type EscalationStage =
  /** Asked by the child, not yet seen by the parent. */
  | "child"
  /** Waiting on the parent. */
  | "parent"
  /** The parent could not answer from its own context; waiting on the user. */
  | "user"
  /** Resolved with a real answer. */
  | "answered"
  /** Unanswered. NOT consent. */
  | "cancelled";

export interface EscalationEvent {
  at: string;
  stage: EscalationStage;
  actor: "child" | "parent" | "user";
  note?: string;
}

export interface Escalation {
  id: string;
  childId: string;
  childName: string;
  scope: string;
  sessionFile: string;
  question: string;
  context?: string;
  options?: string[];
  stage: EscalationStage;
  askedAt: string;
  updatedAt: string;
  answer?: string;
  answeredBy?: "parent" | "user";
  history: EscalationEvent[];
}

export class EscalationError extends Error {}

export interface OpenEscalationInput {
  id: string;
  childId: string;
  childName: string;
  scope: string;
  sessionFile: string;
  question: string;
  context?: string;
  options?: string[];
  now?: Date;
}

export class EscalationLedger {
  private readonly byId = new Map<string, Escalation>();

  /** A child's question always enters the ladder addressed to the parent. */
  open(input: OpenEscalationInput): Escalation {
    const question = String(input.question ?? "").trim();
    if (!question) {
      throw new EscalationError("An escalation needs a question. Report the blocker instead of pinging with nothing.");
    }
    const now = (input.now ?? new Date()).toISOString();
    const escalation: Escalation = {
      id: input.id,
      childId: input.childId,
      childName: input.childName,
      scope: input.scope,
      sessionFile: input.sessionFile,
      question,
      ...(input.context ? { context: String(input.context).trim() } : {}),
      ...(input.options?.length ? { options: input.options.map(String) } : {}),
      stage: "parent",
      askedAt: now,
      updatedAt: now,
      history: [{ at: now, stage: "parent", actor: "child", note: "Question raised by child." }],
    };
    this.byId.set(escalation.id, escalation);
    return escalation;
  }

  get(id: string): Escalation | undefined {
    return this.byId.get(id);
  }

  all(): Escalation[] {
    return [...this.byId.values()];
  }

  /** Rehydrate from a persistence snapshot. A restored escalation keeps its stage and history. */
  restore(escalation: Escalation): void {
    if (!escalation?.id) return;
    this.byId.set(escalation.id, migrateLegacyEscalation(escalation));
  }

  /**
   * Drop every escalation. The ledger outlives a session switch in the same
   * process, so a new session must start with its own ladder rather than
   * answering questions asked by the session it replaced.
   */
  clear(): void {
    this.byId.clear();
  }

  /** Waiting on the parent. */
  forParent(): Escalation[] {
    return this.all().filter((e) => e.stage === "parent");
  }

  /** The parent deferred it: waiting on the user. */
  forUser(): Escalation[] {
    return this.all().filter((e) => e.stage === "user");
  }

  /** Resolved or cancelled — the child can be resumed. */
  settled(): Escalation[] {
    return this.all().filter((e) => e.stage === "answered" || e.stage === "cancelled");
  }

  forChild(childId: string): Escalation[] {
    return this.all().filter((e) => e.childId === childId);
  }

  /**
   * The parent answers from reliable context it actually has.
   *
   * Only legal while the question is addressed to the parent: once it has
   * been handed to the user, answering it here would silently override a decision
   * that was escalated precisely because the parent was not competent to
   * make it.
   */
  answerAsParent(id: string, answer: string, now = new Date()): Escalation {
    const escalation = this.requireOpen(id);
    if (escalation.stage !== "parent") {
      throw new EscalationError(
        `Escalation ${id} is with ${escalation.stage === "user" ? "the user" : escalation.stage}. ` +
          `The parent cannot answer a question it already escalated.`,
      );
    }
    return this.resolve(escalation, answer, "parent", "Answered by the parent from its own context.", now);
  }

  /**
   * The parent does not know either. Hand it to the user.
   *
   * A reason is required, because "escalate" without one is how a parent
   * hides that it simply did not look.
   */
  escalateToUser(id: string, reason: string, now = new Date()): Escalation {
    const escalation = this.requireOpen(id);
    const why = String(reason ?? "").trim();
    if (!why) {
      throw new EscalationError(
        `Escalating ${id} needs a reason: what did the parent check, and what decision is it not competent to make?`,
      );
    }
    if (escalation.stage === "user") return escalation;
    if (escalation.stage !== "parent") {
      throw new EscalationError(`Escalation ${id} is ${escalation.stage}; only a parent-pending question can be escalated.`);
    }
    const at = now.toISOString();
    return this.transition(escalation, "user", {
      at,
      stage: "user",
      actor: "parent",
      note: `Escalated to user: ${why}`,
    });
  }

  /** The user decides. This is the only path that carries user authority. */
  answerAsUser(id: string, answer: string, now = new Date()): Escalation {
    const escalation = this.requireOpen(id);
    const text = String(answer ?? "").trim();
    if (!text) {
      // A blank or dismissed dialog is unanswered. Treating it as an answer would
      // resume the child with an invented decision.
      return this.cancel(id, "User dialog closed without an answer.", now);
    }
    return this.resolve(escalation, text, "user", "Answered by user.", now);
  }

  /** Unanswered, and explicitly not consent. */
  cancel(id: string, reason: string, now = new Date()): Escalation {
    const escalation = this.requireOpen(id, /* allowSettled */ false);
    const at = now.toISOString();
    return this.transition(escalation, "cancelled", {
      at,
      stage: "cancelled",
      actor: "user",
      note: `Cancelled (not consent): ${String(reason ?? "").trim() || "no reason given"}`,
    });
  }

  /**
   * The message a resumed child receives.
   *
   * Stated so the child cannot read consent into a cancellation, and so an answer
   * arrives attributed — a child that cannot tell who decided cannot weigh the
   * decision.
   */
  resumeMessage(id: string): string {
    const escalation = this.byId.get(id);
    if (!escalation) throw new EscalationError(`No escalation ${id}.`);
    if (escalation.stage === "answered") {
      const who = escalation.answeredBy === "user" ? "the user" : "the parent";
      return [
        `Answer to your question — decided by ${who}:`,
        "",
        `Your question: ${escalation.question}`,
        `Decision: ${escalation.answer}`,
        "",
        `Apply this decision and continue. If it contradicts your handoff spec, the decision wins for the line it names; note the change in your report.`,
      ].join("\n");
    }
    if (escalation.stage === "cancelled") {
      return [
        `Your question was NOT answered, and this is NOT approval to proceed on your own reading.`,
        "",
        `Your question: ${escalation.question}`,
        "",
        `Stop this line of work and report the blocker in your final message, naming the decision you need. Do not pick an interpretation and continue.`,
      ].join("\n");
    }
    throw new EscalationError(
      `Escalation ${id} is still ${escalation.stage}; it has no answer to deliver. Resume only after it is answered or cancelled.`,
    );
  }

  private requireOpen(id: string, allowSettled = true): Escalation {
    const escalation = this.byId.get(id);
    if (!escalation) throw new EscalationError(`No escalation ${id}.`);
    if (!allowSettled && (escalation.stage === "answered" || escalation.stage === "cancelled")) {
      throw new EscalationError(`Escalation ${id} is already ${escalation.stage} and cannot be changed again.`);
    }
    if (escalation.stage === "answered") {
      throw new EscalationError(`Escalation ${id} is already answered; a settled decision is not renegotiated.`);
    }
    return escalation;
  }

  private resolve(
    escalation: Escalation,
    answer: string,
    by: "parent" | "user",
    note: string,
    now: Date,
  ): Escalation {
    const text = String(answer ?? "").trim();
    if (!text) return this.cancel(escalation.id, "Empty answer treated as unanswered.", now);
    const at = now.toISOString();
    escalation.answer = text;
    escalation.answeredBy = by;
    return this.transition(escalation, "answered", {
      at,
      stage: "answered",
      actor: by,
      note,
    });
  }

  private transition(escalation: Escalation, stage: EscalationStage, event: EscalationEvent): Escalation {
    escalation.stage = stage;
    escalation.updatedAt = event.at;
    escalation.history.push(event);
    return escalation;
  }
}

/**
 * The stage/actor names this ledger used before the parent/child rename.
 *
 * Stored escalations outlive the code that wrote them: a session restored after
 * an upgrade still carries `"orchestrator"` in its stage, actor, answeredBy and
 * history. Translating on read keeps those questions answerable instead of
 * stranding a child on a stage the current ladder does not know.
 */
const LEGACY_STAGE: Readonly<Record<string, EscalationStage>> = { orchestrator: "parent" };

function legacyActor(value: unknown): "child" | "parent" | "user" | undefined {
  if (value === "orchestrator") return "parent";
  if (value === "child" || value === "parent" || value === "user") return value;
  return undefined;
}

/**
 * Map a persisted escalation onto the current vocabulary. Unknown fields pass
 * through; the record is read as loose data because a stored one may carry a
 * stage this build no longer declares.
 */
export function migrateLegacyEscalation(escalation: Escalation): Escalation {
  const raw = escalation as unknown as Record<string, unknown>;
  const stage = LEGACY_STAGE[String(raw.stage)] ?? escalation.stage;
  const answeredByRaw = raw.answeredBy;
  const answeredBy = answeredByRaw === "orchestrator"
    ? "parent"
    : answeredByRaw === "parent" || answeredByRaw === "user"
      ? answeredByRaw
      : undefined;
  const history = Array.isArray(escalation.history)
    ? escalation.history.map((event) => {
      const loose = event as unknown as Record<string, unknown>;
      const eventActor = legacyActor(loose.actor);
      return {
        ...event,
        stage: LEGACY_STAGE[String(loose.stage)] ?? event.stage,
        ...(eventActor ? { actor: eventActor } : {}),
      };
    })
    : [];
  return {
    ...escalation,
    stage,
    ...(answeredBy ? { answeredBy } : {}),
    history,
  } as Escalation;
}
