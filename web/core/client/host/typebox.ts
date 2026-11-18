/**
 * One browser copy of Typebox for the app, host runtime and plugin halves.
 * The SDK needs it to validate bridge envelopes; without a shared shim every
 * entry bundles its own copy of the same schema runtime.
 */
export * from "typebox";
export { Value } from "typebox/value";
