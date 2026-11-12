// Parser for an artifact's published markdown body. The artifacts extension
// writes a deterministic `key:value` metadata line, then a blank line, then
// the artifact content, so the browser can reconstruct type/id/version/size/
// tags without asking the pi process. Values ride after the FIRST colon, so
// ISO timestamps and `subagent:name:run` authors stay intact.

export interface ArtifactMeta {
  id: string;
  type: string;
  version: number;
  size: string;
  author: string;
  updatedAt: string;
  tags: string[];
}

export interface ParsedArtifact {
  meta: ArtifactMeta;
  content: string;
}

export const ARTIFACT_META_DELIMITER = " · ";
const BLANK_LINE = "\n\n";

function emptyMeta(): ArtifactMeta {
  return { id: "", type: "other", version: 1, size: "", author: "", updatedAt: "", tags: [] };
}

/** Split `key:value` on the first colon; a segment without a colon is skipped. */
function parseMetaLine(line: string): ArtifactMeta {
  const meta = emptyMeta();
  if (line.trim() === "") return meta;
  for (const segment of line.split(ARTIFACT_META_DELIMITER)) {
    const colon = segment.indexOf(":");
    if (colon <= 0) continue;
    const key = segment.slice(0, colon);
    const value = segment.slice(colon + 1);
    switch (key) {
      case "id":
        meta.id = value;
        break;
      case "type":
        meta.type = value !== "" ? value : "other";
        break;
      case "version": {
        const version = Number(value);
        meta.version = Number.isFinite(version) ? version : 1;
        break;
      }
      case "size":
        meta.size = value;
        break;
      case "author":
        meta.author = value;
        break;
      case "updated":
        meta.updatedAt = value;
        break;
      case "tags": {
        try {
          const parsed = JSON.parse(value) as unknown;
          if (Array.isArray(parsed)) {
            meta.tags = parsed.filter((tag): tag is string => typeof tag === "string");
          }
        } catch {
          // A malformed tags value degrades to no tags, never a crash.
        }
        break;
      }
      default:
        break;
    }
  }
  return meta;
}

/**
 * Parse a published artifact body. When the body has no metadata line (the
 * pre-viewer format, or a fixture's bare title), the whole string is content
 * and metadata falls back to harmless defaults.
 */
export function parseArtifactDetail(detail: string): ParsedArtifact {
  const blank = detail.indexOf(BLANK_LINE);
  if (blank === -1) {
    return { meta: emptyMeta(), content: detail };
  }
  const meta = parseMetaLine(detail.slice(0, blank));
  const content = detail.slice(blank + BLANK_LINE.length).replace(/^\n+/, "");
  return { meta, content };
}

/** Whether an artifact body renders as code vs markdown. */
export function artifactBodyKind(type: string): "code" | "markdown" {
  return type === "code" ? "code" : "markdown";
}