// Component overrides: a plugin replaces, hides, or adds to a host component by
// key (`ui.working-indicator.v1`, `ui.extension-status.v1`, …).
//
// Views are declarative data, so the expressible modes are:
//   replace — the plugin's view renders instead of the built-in;
//   hide    — nothing renders (the built-in is suppressed);
//   wrap    — the plugin's view renders *beside* the built-in, because a
//             declarative view has no way to receive and re-render it. The
//             built-in always survives, which is the honest reading of a
//             fallback: "builtin" wrapper with no plugin markup inside it.
//
// Resolution order is the shared contract's (highest priority, then user choice),
// so this host and `validateRegistry` cannot disagree.

import type { ReactNode } from "react";
import type { WebPluginDescriptor, WebView } from "./contract.ts";
import type { WebUiComponent } from "../../plugin-contracts/ui-contracts.ts";
import { resolveOverrides } from "../../plugin-contracts/ui-contracts.ts";
import { overrideEntries } from "./override-policy.ts";
import { PluginViewRenderer } from "./PluginViewRenderer.tsx";

export interface ComponentOverrideHostProps {
  target: WebUiComponent;
  plugins: readonly WebPluginDescriptor[];
  views: Record<string, WebView> | null | undefined;
  /** Contributions the operator switched off, as `pluginId/contributionId`. */
  disabled?: ReadonlySet<string>;
  /** The operator's chosen replacement, as `pluginId/contributionId`. */
  userChoice?: string;
  /** The built-in rendering this host falls back to. */
  children: ReactNode;
}

export function ComponentOverrideHost({
  target,
  plugins,
  views,
  disabled,
  userChoice,
  children,
}: ComponentOverrideHostProps) {
  const resolved = resolveOverrides(
    target,
    overrideEntries(plugins, target),
    disabled ?? new Set<string>(),
    userChoice,
  );
  if (resolved.hidden) return null;

  const replacement = resolved.replacement;
  if (replacement !== undefined && replacement.contribution.override?.mode === "replace") {
    const view = views?.[replacement.pluginId];
    if (view !== undefined && view !== null) {
      return (
        <div
          className="web-ui-component-override"
          data-component={target}
          data-plugin-id={replacement.pluginId}
        >
          <PluginViewRenderer view={view} />
        </div>
      );
    }
    // No view published: the built-in is the fallback, never a blank space.
  }

  const wrappers = resolved.wrappers
    .map((wrapper) => ({ wrapper, view: views?.[wrapper.pluginId] }))
    .filter((entry) => entry.view !== undefined && entry.view !== null);

  return (
    <>
      {wrappers.map(({ wrapper, view }) => (
        <div
          key={`${wrapper.pluginId}/${wrapper.contribution.id}`}
          className="web-ui-component-wrap"
          data-component={target}
          data-plugin-id={wrapper.pluginId}
        >
          <PluginViewRenderer view={view} />
        </div>
      ))}
      {children}
    </>
  );
}
