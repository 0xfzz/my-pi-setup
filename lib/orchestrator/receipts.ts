/**
 * receipts.ts — a check that actually ran is a different fact from a check that
 * was quoted.
 *
 * Before this module, `agent_review` accepted `{ kind: "cmd", cmd, exit }` as
 * evidence and verified only its *shape*. A model could therefore cite
 * `npm test → exit 0` for a command it never ran, or for one it ran before the
 * last edit, and the gate had no way to tell. That is self-attestation with a
 * receipt-shaped hole in it.
 *
 * A `CheckReceipt` closes both gaps with two hashes and nothing else:
 *
 *   - `criteriaHash` binds the run to the definition of done it was judged
 *     against, so revising the criteria cannot re-bless an older run.
 *   - `treeDigest` binds it to the working tree (changed files + diff text), so
 *     editing after the check invalidates the receipt instead of laundering it.
 *
 * The tree digest deliberately includes pre-existing dirt. That keeps the
 * comparison honest for a shared worktree (the same dirt appears on both sides),
 * and it is why this is freshness and not attribution: two concurrent lanes in
 * one worktree still pollute each other's `git status`, which is a stated
 * limitation of the receipt rather than something the hash pretends to solve.
 */
import { createHash } from "node:crypto";

export interface CheckReceipt {
  id: string;
  scope: string;
  /** The verification command, or null when the check ran no command at all. */
  command: string | null;
  /**
   * The command the HANDOFF declared, or null when it declared none.
   *
   * Without this, `agent_check` could be pointed at any allowed test runner and a
   * receipt from `npm run typecheck` would approve a work unit whose declared
   * check was `npm test` — the exact substitution that declaring the command at
   * authoring time exists to prevent.
   */
  declaredCommand: string | null;
  /**
   * Tail of the command's output, so a cited `test` reference can be checked
   * against what actually printed. Bounded, and in-memory only like the rest of
   * the receipt.
   */
  outputTail: string | null;
  /** Process exit code, or null when nothing ran. */
  exit: number | null;
  /** sha256 of the command's (tail-bounded) output, so the evidence is identifiable. */
  outputDigest: string | null;
  /** sha256 of the acceptance criteria the run was judged against. */
  criteriaHash: string;
  /** Handoff revision at check time, when known. */
  specRevision: number | null;
  /** sha256 of (changed files + diff text) at check time. */
  treeDigest: string;
  createdAt: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Order-insensitive within a criterion, order-sensitive across criteria. */
export function criteriaHashOf(criteria: readonly string[] | undefined): string {
  const normalized = (criteria ?? []).map((criterion) => String(criterion).trim()).filter(Boolean);
  return digest(JSON.stringify(normalized));
}

/**
 * Stable digest of the working tree as git reported it.
 *
 * `null` is not "clean", and it is not a digest either: an unreadable tree yields
 * `null`, so a caller cannot mint a receipt that describes nothing and two
 * unreadable readings can never look equal. Unknown must not equal empty, and it
 * must not equal unknown.
 */
export function treeDigestOf(input: {
  changed: readonly string[] | null;
  diff: string | null;
}): string | null {
  if (input.changed === null || input.diff === null) return null;
  const changed = [...input.changed].map((file) => file.trim()).sort().join("\n");
  return digest(`${changed}\u0000${input.diff}`);
}

export interface ReceiptExpectation {
  scope: string;
  criteriaHash: string;
  /** null when the tree could not be read: that is a refusal, not a wildcard. */
  treeDigest: string | null;
  /** The handoff's declared check. `undefined` means the handoff declared none. */
  declaredCommand?: string | null;
}

/**
 * Why a receipt cannot back an approval.
 *
 * Every reason is returned: the parent should see "criteria changed AND the tree
 * changed" once, not discover the second after fixing the first.
 */
export function evaluateReceipt(receipt: CheckReceipt | undefined, expected: ReceiptExpectation): string[] {
  if (!receipt) return ["no check receipt with that id exists in this session"];
  const problems: string[] = [];
  if (receipt.scope !== expected.scope) {
    problems.push(`the receipt belongs to scope "${receipt.scope}", not "${expected.scope}"`);
  }
  if (receipt.criteriaHash !== expected.criteriaHash) {
    problems.push("the acceptance criteria changed after the check ran, so it judged a different definition of done");
  }
  if (expected.treeDigest === null) {
    problems.push("the working tree could not be read, so what this receipt describes cannot be confirmed");
  } else if (receipt.treeDigest !== expected.treeDigest) {
    problems.push("the working tree changed after the check ran, so its result no longer describes this diff");
  }
  if (expected.declaredCommand !== undefined && receipt.command !== expected.declaredCommand) {
    problems.push(
      `the check ran ${receipt.command ? `"${receipt.command}"` : "no command"} but the handoff declared `
        + `${expected.declaredCommand ? `"${expected.declaredCommand}"` : "none"}: a substituted check does not verify the declared one`,
    );
  }
  if (receipt.command === null) {
    problems.push("the check ran no verification command");
  } else if (receipt.exit === null) {
    problems.push("the check recorded no exit code");
  } else if (receipt.exit !== 0) {
    problems.push(`the check command failed (exit ${receipt.exit}): ${receipt.command}`);
  }
  return problems;
}

/** sha256 of a command's output, so a receipt identifies the evidence it saw. */
export function outputDigestOf(output: string | null | undefined): string | null {
  if (output === null || output === undefined) return null;
  return digest(output.length > 64_000 ? output.slice(-64_000) : output);
}

/** Short human line for the parent's summary. Not a substitute for the receipt. */
export function describeReceipt(receipt: CheckReceipt): string {
  const command = receipt.command ?? "(no command)";
  const swapped = receipt.declaredCommand && receipt.declaredCommand !== receipt.command
    ? ` · substituted for ${receipt.declaredCommand}`
    : "";
  return `${receipt.id} · ${receipt.scope} · ${command}${swapped} → ${
    receipt.command === null ? "not run" : receipt.exit === 0 ? "pass" : `exit ${receipt.exit}`
  } · criteria ${receipt.criteriaHash.slice(0, 10)} · tree ${receipt.treeDigest.slice(0, 10)}`;
}
