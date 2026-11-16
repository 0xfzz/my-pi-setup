// Split markdown at blank lines that sit outside a fenced code block.
//
// A streamed answer grows by a few characters per delta. Parsing the whole
// text on every delta costs time proportional to its length, so the text is
// cut into chunks: every chunk that ends at a blank line is final, and only the
// open chunk at the end (the one still being typed) changes. The renderer keeps
// final chunks memoised by their text, so only the open chunk is parsed again.
//
// A blank line inside a fence is code, not a block boundary, so an open fence
// keeps the rest of the text in the open chunk until it closes.

export interface MarkdownChunks {
  /** Chunks that a blank line has closed; their text will not change. */
  stable: string[];
  /** The text after the last closed chunk; it may still change. */
  open: string;
}

interface Fence {
  char: "`" | "~";
  length: number;
}

const FENCE_OPEN = /^(`{3,}|~{3,})/;

/** The fence a line opens, or null when the line is not a fence line. */
function fenceOpenedBy(line: string): Fence | null {
  const match = FENCE_OPEN.exec(line.trimStart());
  if (match === null) return null;
  return { char: match[1][0] as "`" | "~", length: match[1].length };
}

/** True when the line closes the fence: same character, at least as long, nothing else on the line. */
function closes(line: string, fence: Fence): boolean {
  const trimmed = line.trim();
  return trimmed.length >= fence.length
    && trimmed === fence.char.repeat(trimmed.length);
}

export function splitMarkdownChunks(text: string): MarkdownChunks {
  const stable: string[] = [];
  let current: string[] = [];
  let fence: Fence | null = null;
  for (const line of text.split("\n")) {
    if (fence !== null) {
      if (closes(line, fence)) fence = null;
      current.push(line);
    } else if (line.trim() === "") {
      if (current.length > 0) stable.push(current.join("\n"));
      current = [];
    } else {
      fence = fenceOpenedBy(line);
      current.push(line);
    }
  }
  return { stable, open: current.join("\n") };
}
