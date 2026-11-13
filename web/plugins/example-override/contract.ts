// The example-override bridge contract: the plugin id and action constants
// the pi extension (behavior) and the web descriptor (interface) share.
//   - extensions/example-override.ts imports this to publish the view and
//     handle the action,
//   - web/plugins/example-override/descriptor.ts imports this to declare them.
// The extension never imports the descriptor, nor the descriptor the
// extension; this contract file is the bridge between them.

export const EXAMPLE_OVERRIDE_PLUGIN_ID = "example-override";

export const EXAMPLE_OVERRIDE_SHOW_ACTION = "replace-composer";
