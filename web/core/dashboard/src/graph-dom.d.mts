/**
 * Add (or refresh) a transparent `.node-hit` rect covering the drawn node plus
 * padding, and set the accessible label so it ends with "Open details.".
 */
export function updateNodeElement(element: any, node: any): void;

/**
 * Keep the ambient "alive" classes in sync with the current statuses.
 * Pass `{ motion: false }` under prefers-reduced-motion to add no ambient class.
 */
export function applyActivityClasses(svg: any, graph: any, options?: { motion?: boolean }): void;

/**
 * Decorate the sanitized Graphviz SVG in place. Each node group gets
 * `data-node-id`, `data-node-kind`, role="button", tabindex="0", an aria-label
 * ending with "Open details.", and a `.node-hit` rect that enlarges its target.
 * @returns Map of node id -> svg group
 */
export function decorateGraphSvg(svg: any, graph: any, doc?: any, options?: { motion?: boolean }): Map<string, any>;

/**
 * Refresh status/kind classes, the aria-label, activity classes and the
 * `.node-hit` rect for every node already decorated in `svg`.
 * Returns false when a node is missing.
 */
export function updateGraphSvg(svg: any, graph: any, options?: { motion?: boolean }): boolean;

/** Toggle `is-selected` / `aria-current` on the `.graph-node` matching `nodeId`. */
export function selectGraphNode(svg: any, nodeId: string | null): void;

/** Resolve a pointer event target to the `data-node-id` of its closest `.graph-node`. */
export function graphNodeFromEvent(target: any): string | null;
