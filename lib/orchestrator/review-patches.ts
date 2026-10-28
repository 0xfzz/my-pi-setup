/** Exact, reviewer-authored amendments. Original pins and reports never change. */
import { createHash } from "node:crypto";

export interface ReviewPatch { oldText: string; newText: string }
export interface ReviewPatchRevision {
  targetId: string;
  previousHash: string;
  nextHash: string;
  changes: Array<{ findingId: string; patch: ReviewPatch }>;
  at: string;
}
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** All replacements match the ORIGINAL text; no cascading or partial application. */
export function applyReviewPatches(content: string, changes: ReviewPatchRevision["changes"]): string {
  const ranges = changes.map(({ findingId, patch }) => {
    if (!patch || typeof patch.oldText !== "string" || !patch.oldText || typeof patch.newText !== "string") {
      throw new Error(`${findingId}: a patch needs nonempty oldText and string newText`);
    }
    const start = content.indexOf(patch.oldText);
    if (start < 0 || content.indexOf(patch.oldText, start + 1) >= 0) throw new Error(`${findingId}: oldText must match exactly once`);
    return { start, end: start + patch.oldText.length, text: patch.newText };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i]!.start < ranges[i - 1]!.end) throw new Error("Reviewer patches overlap; resolve the conflict explicitly");
  }
  let result = content;
  for (const range of ranges.reverse()) result = result.slice(0, range.start) + range.text + result.slice(range.end);
  if (!result.trim()) throw new Error("A patch cannot empty a specification");
  return result;
}

/** Recompute the entire receipt chain rather than trusting a stored replacement hash. */
export function replayReviewPatches(original: string, targetId: string, revisions: readonly ReviewPatchRevision[] = []): string {
  let content = original;
  for (const revision of revisions.filter((r) => r.targetId === targetId)) {
    if (digest(content) !== revision.previousHash) throw new Error("Broken reviewer patch chain: previous hash mismatch");
    content = applyReviewPatches(content, revision.changes);
    if (digest(content) !== revision.nextHash) throw new Error("Broken reviewer patch chain: next hash mismatch");
  }
  return content;
}
