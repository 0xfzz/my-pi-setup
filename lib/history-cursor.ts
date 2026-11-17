/** Opaque byte-offset cursors for paginated transcript reads. */

const CURSOR_PREFIX = "h1:";

/** Encode an absolute byte offset as an opaque cursor. */
export function encodeHistoryCursor(offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("history cursor offset must be a non-negative safe integer");
  }
  return Buffer.from(`${CURSOR_PREFIX}${offset}`, "utf8").toString("base64url");
}

/** Decode a cursor, or undefined when it was not issued by this server. */
export function decodeHistoryCursor(cursor: string): number | undefined {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (!decoded.startsWith(CURSOR_PREFIX)) return undefined;
    const digitText = decoded.slice(CURSOR_PREFIX.length);
    if (!/^\d+$/.test(digitText)) return undefined;
    const offset = Number(digitText);
    return Number.isSafeInteger(offset) && offset >= 0 ? offset : undefined;
  } catch {
    return undefined;
  }
}
