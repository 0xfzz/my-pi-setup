// Artifact catalog: one row per artifact with a type icon plus a compact
// type/version/size line. Selecting a row opens its preview in the same panel.

import { Code, FileText, GitPullRequest, ListChecks, Note, Package, type Icon } from "@phosphor-icons/react";
import { parseArtifactDetail } from "./artifact-detail.ts";

const TYPE_ICONS: Record<string, Icon> = {
  plan: ListChecks,
  spec: FileText,
  scratchpad: Note,
  code: Code,
  review: GitPullRequest,
};

function typeIcon(type: string | undefined): Icon {
  return (type !== undefined && TYPE_ICONS[type]) || Package;
}

export interface ArtifactRow {
  title: string;
  detail: string | null;
}

export function ArtifactCatalog({ items, onSelect }: { items: ArtifactRow[]; onSelect: (index: number) => void }) {
  return (
    <div className="artifacts-catalog" role="listbox" aria-label="Artifacts" data-testid="artifacts-catalog">
      {items.map((item, index) => {
        const meta = item.detail === null ? null : parseArtifactDetail(item.detail).meta;
        const Icon = typeIcon(meta?.type);
        return (
          <button
            key={item.title + index}
            type="button"
            className="artifacts-row"
            onClick={() => onSelect(index)}
          >
            <span className="artifacts-row-icon"><Icon size={15} aria-hidden="true" /></span>
            <span className="artifacts-row-name">{item.title}</span>
            {meta !== null ? (
              <span className="artifacts-row-meta">{meta.type} · v{meta.version} · {meta.size || "—"}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}