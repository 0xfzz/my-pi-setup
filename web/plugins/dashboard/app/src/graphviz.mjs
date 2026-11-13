/**
 * Local Graphviz via the @viz-js/viz WebAssembly build. The wasm payload is
 * embedded in the package's JS bundle, so there is no CDN, no native graphviz
 * binary and no runtime asset fetch.
 */

let instancePromise = null;

export async function loadGraphviz() {
  if (!instancePromise) {
    instancePromise = import("@viz-js/viz")
      .then((module) => module.instance())
      .catch((error) => {
        instancePromise = null;
        throw error;
      });
  }
  return instancePromise;
}

/** Render DOT to SVG text. Layout is Graphviz's deterministic layered layout. */
export async function renderDot(dot) {
  const viz = await loadGraphviz();
  return viz.renderString(String(dot), { format: "svg" });
}
