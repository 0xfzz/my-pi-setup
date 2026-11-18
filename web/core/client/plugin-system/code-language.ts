/** Languages with a dedicated lazy highlighter in the shared code view. */
export type CodeLanguage =
  | "css"
  | "html"
  | "javascript"
  | "json"
  | "jsx"
  | "python"
  | "rust"
  | "shell"
  | "tsx"
  | "typescript"
  | "yaml";

const EXTENSION_LANGUAGES: Readonly<Record<string, CodeLanguage>> = Object.freeze({
  css: "css",
  html: "html",
  htm: "html",
  js: "javascript",
  cjs: "javascript",
  mjs: "javascript",
  jsx: "jsx",
  json: "json",
  less: "css",
  py: "python",
  rs: "rust",
  scss: "css",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ts: "typescript",
  cts: "typescript",
  mts: "typescript",
  tsx: "tsx",
  xml: "html",
  yaml: "yaml",
  yml: "yaml",
});

/** Resolve a preview filename to its syntax highlighter, if one is supported. */
export function codeLanguageForFilename(filename: string | undefined): CodeLanguage | undefined {
  if (filename === undefined) return undefined;
  const basename = filename.split(/[\\/]/).at(-1) ?? "";
  const dot = basename.lastIndexOf(".");
  // A leading dot alone is a hidden filename, not an extension.
  if (dot <= 0) return undefined;
  return EXTENSION_LANGUAGES[basename.slice(dot + 1).toLowerCase()];
}
