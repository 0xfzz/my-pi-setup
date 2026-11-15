import type { WebPluginDescriptor } from "../../core/plugin-contracts/descriptor.ts";
import {
  PROVIDERS_ADD_ACTION,
  PROVIDERS_BACK_ACTION,
  PROVIDERS_CANCEL_ACTION,
  PROVIDERS_NEXT_ACTION,
  PROVIDERS_PLUGIN_ID,
} from "./contract.ts";

/**
 * The provider wizard's web surface.
 *
 * Dialog-only: the host's one dialog layer renders the step the extension
 * publishes, and the actions route back through the plugin action pipeline to
 * the pi process that owns models.json. There is no panel and no page, so no
 * placement is declared.
 */
export const providersPlugin: WebPluginDescriptor = {
  id: PROVIDERS_PLUGIN_ID,
  extension: "providers",
  title: "Providers",
  description:
    "Add a provider or a model to models.json as a step-by-step dialog, opened from the model picker.",
  surfaces: [{ kind: "dialog" }],
  actions: [
    { id: PROVIDERS_ADD_ACTION, title: "Add provider" },
    { id: PROVIDERS_NEXT_ACTION, title: "Continue to the next step" },
    { id: PROVIDERS_BACK_ACTION, title: "Go back one step" },
    { id: PROVIDERS_CANCEL_ACTION, title: "Close without saving" },
  ],
};

export default providersPlugin;
