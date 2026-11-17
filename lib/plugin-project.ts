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

function camel(id: string): string {
  return id.replace(/(^|[.-])([a-z])/g, (_match, _sep: string, letter: string) => letter.toUpperCase());
}

/** Public protocol surface a plugin project may import from this repo. */
export const PUBLIC_PROTOCOL_PATHS: readonly string[] = [
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

/** Generate a complete trusted plugin project; the target folder is never deleted. */
export function scaffoldPluginProject(id: string, title = id): ScaffoldResult {
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
      scripts: { check: "node ../../scripts/check-web-plugin.mjs ." },
      dependencies: { "@pi-web/bridge-protocol": "^1.0.0" },
    }, null, 2)}\n` },
    { path: "pi-web-plugin.json", content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: "contract.ts", content: `export const ${name.toUpperCase()}_PLUGIN_ID = "${id}";\n` },
    {
      path: "browser.ts",
      content: `import type { BridgeEnvelope } from "@pi-web/bridge-protocol";

export function mount(el: HTMLElement, ctx: { logger: { info(message: string): void } }): () => void {
  const node = document.createTextNode("${title} plugin");
  el.appendChild(node);
  ctx.logger.info("${id} mounted");
  return () => node.remove();
}

export function onProtocol(envelope: BridgeEnvelope): void {
  ctxInfo(envelope.name);
}
function ctxInfo(name: string): void { void name; }
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

/** AC10: name every import of web/core internals, including relative escapes. */
export function checkPluginProject(root: string, files: readonly ProjectFile[]): readonly ImportViolation[] {
  const violations: ImportViolation[] = [];
  for (const file of files) {
    for (const [index, line] of file.content.split("\n").entries()) {
      for (const match of line.matchAll(/(?:import|export)[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']/g)) {
        const specifier = match[1] ?? match[2];
        if (specifier === undefined) continue;
        const absolute = resolve(root, file.path, "..", specifier).split(sep).join("/");
        const coreAt = absolute.lastIndexOf("/web/core/");
        const target = coreAt === -1 ? specifier : absolute.slice(coreAt + 1);
        if (!target.startsWith("web/core/")) continue;
        if (PUBLIC_PROTOCOL_PATHS.some((prefix) => target.startsWith(prefix))) continue;
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
