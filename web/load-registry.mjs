/** Plain-Node bridge to the single TypeScript registration file. */
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

export const registry = await jiti.import("./config/registry.config.ts");
