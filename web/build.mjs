// Bundle the React client into client/dist with esbuild.
// Output: dist/app.js (bundled, minified, sourcemapped),
//         dist/index.html + dist/app.css (copied verbatim).

import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("client/dist", { recursive: true, force: true });
await mkdir("client/dist", { recursive: true });

await build({
  entryPoints: ["client/app.tsx"],
  bundle: true,
  format: "esm",
  outfile: "client/dist/app.js",
  minify: true,
  sourcemap: true,
  jsx: "automatic",
  target: "es2022",
  logLevel: "info",
});

await cp("client/index.html", "client/dist/index.html");
await cp("client/base.css", "client/dist/app.css");
