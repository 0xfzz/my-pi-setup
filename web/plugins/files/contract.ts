/**
 * The Files plugin's identity. It ships as a manifest (`pi-web-plugin.json`)
 * rather than a descriptor module, because it has a server half; the id is
 * still shared by the two places that need it — the panel registration and the
 * plugin's own backend mount.
 */
export const FILES_PLUGIN_ID = "files";

/** Everything under this prefix is the Files plugin's own backend surface. */
export const FILES_API_PATH = `/api/p/${FILES_PLUGIN_ID}`;
