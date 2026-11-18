/** Pure plugin-project scaffold and import-boundary rules (PL1, PL3, PL7). */
import { isAbsolute, resolve, sep } from "node:path";

export interface ProjectFile {
  readonly path: string;
  readonly content: string;
}

export interface ScaffoldResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly files: readonly ProjectFile[];
}

const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

/** The installable protocol package; plugins import it instead of web/core paths. */
const BRIDGE_SDK_SPECIFIER = "@pi-web/bridge";

function camel(id: string): string {
  return id.replace(/(^|[.-])([a-z])/g, (_match, _sep: string, letter: string) => letter.toUpperCase());
}

/** Deprecated core paths still used by unmigrated first-party plugins. */
export const LEGACY_PUBLIC_PROTOCOL_PATHS: readonly string[] = [
  "web/core/protocol/",
  "web/core/client/protocol-client.ts",
  "web/core/client/plugin-system/panel-registry.tsx",
  "web/core/client/plugin-system/browser-loader.ts",
  "web/core/adapters/",
  "web/core/plugin-contracts/view.ts",
  "web/core/plugin-contracts/descriptor.ts",
  "web/core/plugin-contracts/actions.ts",
  "web/core/plugin-contracts/ui-contracts.ts",
];

/** New projects depend only on the installable bridge SDK. */
export const PUBLIC_PROTOCOL_PATHS: readonly string[] = [];

export interface CheckProjectOptions {
  /** Allow the legacy core paths for an unmigrated first-party package. */
  readonly allowLegacy?: boolean;
}

export interface ScaffoldOptions {
  /** Absolute path to the checker when scaffolding outside this repository. */
  readonly checkerPath?: string;
}

/** Generate a complete trusted plugin project; the target folder is never deleted. */
export function scaffoldPluginProject(id: string, title = id, options: ScaffoldOptions = {}): ScaffoldResult {
  if (!ID_RE.test(id) || id.length > 100) {
    return { ok: false, error: `invalid plugin id "${id}"`, files: [] };
  }
  const name = camel(id);
  const manifest = {
    id,
    name: title,
    version: "0.1.0",
    engines: { piWeb: "^1.0.0", sdk: "^1.0.0" },
    main: { browser: "./browser.ts" },
    trust: "trusted",
    capabilities: ["ui.publish", "commands"],
    activation: ["onStartup"],
    contributes: { title },
  };
  const files: ProjectFile[] = [
    { path: "package.json", content: `${JSON.stringify({
      name: `@pi-web-plugin/${id}`,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        build: "node build.mjs",
        check: `node "${options.checkerPath ?? "../../scripts/check-web-plugin.mjs"}" .`,
      },
      dependencies: { [BRIDGE_SDK_SPECIFIER]: "^1.0.0" },
      devDependencies: { esbuild: "^0.28.2" },
    }, null, 2)}\n` },
    { path: "pi-web-plugin.json", content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: "contract.ts", content: `export const ${name.toUpperCase()}_PLUGIN_ID = "${id}";\n` },
    {
      path: "browser.ts",
      content: `export function mount(el, ctx) {
  const node = document.createTextNode("${title} plugin");
  el.appendChild(node);
  ctx.logger.info("${id} mounted");
  return () => node.remove();
}
`,
    },
    {
      path: "build.mjs",
      content: `import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(root, "browser.ts"), "utf8");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "browser.js"), source, "utf8");
console.log("built dist/browser.js");
`,
    },
    { path: "README.md", content: `# ${title}\n\nRun \`npm run check\` to validate the import boundary.\n` },
  ];
  return { ok: true, files };
}

export interface ImportViolation {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
}

/** Only the package root and real subpaths are SDK imports; no traversal out of it. */
function isBridgeSdkImport(specifier: string): boolean {
  if (specifier === BRIDGE_SDK_SPECIFIER) return true;
  const prefix = `${BRIDGE_SDK_SPECIFIER}/`;
  if (!specifier.startsWith(prefix)) return false;
  const subpath = specifier.slice(prefix.length);
  return subpath.length > 0
    && !subpath.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

/** AC10: name every import of web/core internals, including relative escapes. */
export function checkPluginProject(
  root: string,
  files: readonly ProjectFile[],
  options: CheckProjectOptions = {},
): readonly ImportViolation[] {
  const violations: ImportViolation[] = [];
  const allowed = options.allowLegacy === true
    ? [...PUBLIC_PROTOCOL_PATHS, ...LEGACY_PUBLIC_PROTOCOL_PATHS]
    : PUBLIC_PROTOCOL_PATHS;
  for (const file of files) {
    for (const [index, line] of file.content.split("\n").entries()) {
      for (const match of line.matchAll(/(?:import|export)[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']/g)) {
        const specifier = match[1] ?? match[2];
        if (specifier === undefined || isBridgeSdkImport(specifier)) continue;
        const absolute = resolve(root, file.path, "..", specifier).split(sep).join("/");
        const coreAt = absolute.lastIndexOf("/web/core/");
        const target = coreAt === -1
          ? specifier.replace(/^(?:\.\.\/)+/, "web/")
          : absolute.slice(coreAt + 1);
        if (!target.startsWith("web/core/")) continue;
        if (allowed.some((prefix) => target.startsWith(prefix))) continue;
        violations.push({ file: file.path, line: index + 1, specifier });
      }
    }
  }
  return violations;
}

/** Extra plugin project roots from the dev-loop environment, never the whole tree. */
export function pluginProjectRoots(env: Record<string, string | undefined>): string[] {
  return (env.PI_WEB_PLUGIN_ROOTS ?? "")
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && isAbsolute(entry));
}
