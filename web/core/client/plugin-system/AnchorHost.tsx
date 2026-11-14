// Anchor host: mounts the plugin views that asked for one named anchor.
//
// The host owns the spot (header, above the composer, beside the working line,
// inside the sidebar) and the plugin only asked to be there, so the anchor's
// own layout still decides how much room it gets. Views are already validated
// declarative data — nothing here executes plugin code.

import type { CSSProperties } from "react";
import type { WebPluginDescriptor, WebView } from "./contract.ts";
import { anchorEntries } from "./anchor-policy.ts";
import { PluginViewRenderer } from "./PluginViewRenderer.tsx";
import type { WebUiAnchor } from "../../plugin-contracts/ui-contracts.ts";

/** Height ceilings the host enforces, so a placement hint can ask for less only. */
const ANCHOR_BODY_CEILING_PX = 240;

export interface AnchorHostProps {
  anchor: WebUiAnchor;
  plugins: readonly WebPluginDescriptor[];
  views: Record<string, WebView> | null | undefined;
  running?: boolean;
  suppressed?: ReadonlySet<string>;
  className?: string;
}

export function AnchorHost({ anchor, plugins, views, running, suppressed, className }: AnchorHostProps) {
  const entries = anchorEntries(plugins, views, {
    anchor,
    ...(running !== undefined ? { running } : {}),
    ...(suppressed !== undefined ? { suppressed } : {}),
  });
  if (entries.length === 0) return null;

  return (
    <div
      className={`web-ui-anchor${className !== undefined ? ` ${className}` : ""}`}
      data-web-ui-anchor={anchor}
    >
      {entries.map((entry) => {
        const strategy = entry.contribution.strategy ?? "default";
        const collision = entry.contribution.placement.collision ?? "stack";
        return (
          <div
            key={`${entry.pluginId}/${entry.contribution.id}`}
            className={`web-ui-contribution web-ui-contribution-${strategy}`}
            data-plugin-id={entry.pluginId}
            data-contribution-id={entry.contribution.id}
            data-collision={collision}
            style={
              {
                "--anchor-max-height": `${Math.min(entry.contribution.placement.maxHeight ?? ANCHOR_BODY_CEILING_PX, ANCHOR_BODY_CEILING_PX)}px`,
              } as CSSProperties
            }
          >
            <PluginViewRenderer view={entry.view} />
          </div>
        );
      })}
    </div>
  );
}
