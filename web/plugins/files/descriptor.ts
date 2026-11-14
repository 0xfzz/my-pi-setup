import type { WebPluginDescriptor } from "../../core/plugin-contracts/descriptor.ts";

export const filesPlugin: WebPluginDescriptor = {
  id: "files",
  extension: "web-core.files",
  title: "Files",
  icon: "files",
  description: "Session-scoped file browser, preview, and document viewer.",
  surfaces: [
    { kind: "sidebar" },
  ],
  sessionPanel: true,
};

export default filesPlugin;
