// Shared constants for the example-override web plugin — the neutral home
// BOTH sides import (the pattern from lib/modes-web-view.ts):
//   - extensions/example-override.ts (behavior: handles the action,
//     publishes the view),
//   - web-plugins/example-override.ts (interface: the descriptor that
//     declares the view and the action).
// The extension must not import the interface side, nor the interface the
// extension; the contract constants live here, between them.

export const EXAMPLE_OVERRIDE_PLUGIN_ID = "example-override";

export const EXAMPLE_OVERRIDE_SHOW_ACTION = "replace-composer";
