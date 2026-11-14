// Override policy: which contributions claim a host component key, and who owns
// them. Pure data so the resolution rules are unit-tested without React; the
// host component only renders the answer.

import type { WebPluginDescriptor } from "./contract.ts";
import type { OwnedContribution, WebUiComponent } from "../../plugin-contracts/ui-contracts.ts";

/** Every override contribution aimed at `target`, attributed to its plugin. */
export function overrideEntries(
  plugins: readonly WebPluginDescriptor[],
  target: WebUiComponent,
): OwnedContribution[] {
  return plugins.flatMap((plugin) =>
    (plugin.ui ?? [])
      .filter((contribution) => contribution.override?.target === target)
      .map((contribution) => ({ pluginId: plugin.id, contribution })),
  );
}
