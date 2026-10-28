/** Amend prose only; lanes, criteria and dependencies are structural decisions. */
import { renderHandoffForChild, type HandoffRecord } from "./handoff.ts";
import { applyReviewPatches, type ReviewPatchRevision } from "./review-patches.ts";

export function amendHandoff(record: HandoffRecord, changes: ReviewPatchRevision["changes"]): HandoffRecord {
  const content = renderHandoffForChild(record);
  const expected = applyReviewPatches(content, changes);
  const next: HandoffRecord = { ...record, interfaces: record.interfaces ? [...record.interfaces] : undefined };
  const fields = ["goal", "guidance", "vision", "reportShape"] as const;
  for (const { findingId, patch } of changes) {
    let found = false;
    // Match against the original field values; apply all changes together below.
    for (const key of fields) if (record[key]?.includes(patch.oldText)) found = true;
    if (record.interfaces?.some((value) => value.includes(patch.oldText))) found = true;
    if (!found) throw new Error(`${findingId}: structural handoff amendment (lane, criteria, dependencies or boundaries). Re-author explicitly; do not start another review automatically.`);
  }
  for (const key of fields) {
    const value = record[key];
    if (value) next[key] = applyReviewPatches(value, changes.filter((c) => value.includes(c.patch.oldText)));
  }
  if (record.interfaces) next.interfaces = record.interfaces.map((value) => applyReviewPatches(value, changes.filter((c) => value.includes(c.patch.oldText))));
  if (renderHandoffForChild(next) !== expected) throw new Error("Patch would desynchronise the handoff metadata and the worker's artifact");
  return next;
}
