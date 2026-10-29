/**
 * Parse shell structure, never execute it. Quoted strings, loop values and
 * command substitutions are not interchangeable with filesystem operands.
 *
 * Values are resolved only from literal assignments/for lists and $HOME. Unknown
 * values stay unknown; the consumer asks only if one occupies a path/code slot.
 */
import { createRequire } from "node:module";
import type Parser from "tree-sitter";

export interface ShellWord {
  text: string;
  value?: string;
}

export interface ShellCommand {
  source: string;
  words: ShellWord[];
  redirects: Array<{ target: ShellWord; write: boolean }>;
  heredoc: boolean;
  scope?: "enter" | "leave";
}

export interface ShellScan {
  commands: ShellCommand[];
  reason?: string;
}

type Node = Parser.SyntaxNode;
type Variables = Map<string, string | undefined>;
const MAX_SOURCE = 64 * 1024;
const MAX_STEPS = 4096;

/**
 * The parser is a native module, so it is loaded on demand and defensively: a
 * machine without a build for it must degrade to "ask" (an opacity reason), never
 * take the extension down with it.
 */
let cachedParser: Parser | null | undefined;
function parserFor(): Parser | null {
  if (cachedParser !== undefined) return cachedParser;
  try {
    const require = createRequire(import.meta.url);
    const instance = new (require("tree-sitter") as typeof Parser)();
    instance.setLanguage(require("tree-sitter-bash"));
    cachedParser = instance;
  } catch {
    cachedParser = null;
  }
  return cachedParser;
}

/** Lower a bounded Bash AST to commands with resolved literal arguments. */
export function scanShell(source: string): ShellScan {
  const commands: ShellCommand[] = [];
  let reason: string | undefined;
  let steps = 0;
  const unsupported = (message: string) => { reason ??= message; };
  if (source.length > MAX_SOURCE) return { commands, reason: "shell source exceeds the analysis limit" };
  const analysis = parserFor();
  if (!analysis) return { commands, reason: "the shell parser is unavailable on this platform" };
  const deadline = performance.now() + 200;
  analysis.reset();
  let tree: Parser.Tree;
  try {
    tree = analysis.parse(source, null, { progressCallback: () => performance.now() > deadline });
    if (!tree || tree.rootNode.hasError) return { commands, reason: "shell syntax is incomplete or unsupported" };
  } catch {
    return { commands, reason: "shell parser could not analyze this command" };
  }

  const step = (): boolean => {
    if (++steps <= MAX_STEPS) return true;
    unsupported("shell analysis exceeds the work limit");
    return false;
  };

  function value(node: Node, vars: Variables): string | undefined {
    if (!step()) return undefined;
    switch (node.type) {
      case "word":
      case "number":
      case "string_content":
        return node.text.replace(/\\\n/g, "").replace(/\\(.)/gs, "$1");
      case "raw_string": return node.text.slice(1, -1);
      case "simple_expansion":
      case "expansion": {
        const name = node.namedChildren.find(child => child.type === "variable_name")?.text;
        // Only simple $name and ${name}; no evaluation of parameter operators.
        if (!name || !new RegExp(`^\\$\\{?${name}\\}?$`).test(node.text)) return undefined;
        return vars.get(name);
      }
      case "string":
      case "concatenation": {
        const parts = node.namedChildren.map(child => value(child, vars));
        return parts.some(part => part === undefined) ? undefined : parts.join("");
      }
      default: return undefined;
    }
  }

  const word = (node: Node, vars: Variables): ShellWord => ({ text: node.text, value: value(node, vars) });

  // Substitutions execute commands, but their *output* is data. Walk those
  // commands in their own scope; do not treat the entire surrounding word as code.
  function substitutions(node: Node, vars: Variables): void {
    if (!step()) return;
    if (node.type === "command_substitution") {
      scope("enter");
      const local = new Map(vars);
      for (const child of node.namedChildren) visit(child, local);
      scope("leave");
    } else if (node.type === "process_substitution") {
      unsupported("process substitution requires an explicit approval");
    } else {
      for (const child of node.namedChildren) substitutions(child, vars);
    }
  }

  function assign(node: Node, vars: Variables): void {
    substitutions(node, vars);
    const name = node.childForFieldName("name")?.text;
    const target = node.childForFieldName("value");
    if (name) vars.set(name, target ? value(target, vars) : "");
  }

  function scope(kind: "enter" | "leave"): void {
    commands.push({ source: "", words: [], redirects: [], heredoc: false, scope: kind });
  }

  function visit(node: Node, vars: Variables): void {
    if (!step()) return;
    switch (node.type) {
      case "program":
      case "do_group":
      case "compound_statement":
      case "list":
      case "pipeline":
        for (const child of node.namedChildren) visit(child, vars);
        return;
      case "comment": return;
      case "subshell": {
        // A cd in a subshell must not change a later command's cwd.
        scope("enter");
        const local = new Map(vars);
        for (const child of node.namedChildren) visit(child, local);
        scope("leave");
        return;
      }
      case "variable_assignment": assign(node, vars); return;
      case "for_statement": {
        const name = node.childForFieldName("variable")?.text;
        const values = node.childrenForFieldName("value");
        const body = node.childForFieldName("body");
        if (!name || !body || !values.length) {
          unsupported("for loop has no statically known value list");
          return;
        }
        const prior = vars.get(name);
        for (const item of values) {
          substitutions(item, vars);
          const literal = value(item, vars);
          if (literal === undefined || /[*?[\]]/.test(literal)) {
            unsupported("for loop values require runtime expansion");
            return;
          }
          vars.set(name, literal);
          visit(body, vars);
        }
        vars.set(name, prior);
        return;
      }
      case "command": {
        const local = new Map(vars);
        for (const child of node.namedChildren) {
          if (child.type === "variable_assignment") assign(child, local);
          else substitutions(child, local);
        }
        const name = node.childForFieldName("name");
        if (!name) return;
        const nameWord = name.namedChildren[0] ?? name;
        commands.push({
          source: node.text,
          words: [word(nameWord, local), ...node.childrenForFieldName("argument").map(arg => word(arg, local))],
          redirects: [],
          heredoc: false,
        });
        return;
      }
      case "redirected_statement": {
        const start = commands.length;
        const body = node.childForFieldName("body");
        if (body) visit(body, vars);
        const redirects: ShellCommand["redirects"] = [];
        let heredoc = false;
        for (const redirect of node.childrenForFieldName("redirect")) {
          if (redirect.type === "heredoc_redirect" || redirect.type === "herestring_redirect") {
            heredoc = true;
            // A heredoc body is data, always. `git commit -F - <<EOF` feeds text,
            // and even `cat > file <<'PY'` is a program only for whoever reads the
            // file later. Scanning it as shell code made a quoted heredoc that
            // merely *mentions* `$(...)` look like an escape.
            continue;
          }
          const destination = redirect.childForFieldName("destination");
          if (!destination) { unsupported("redirect has no destination"); continue; }
          substitutions(destination, vars);
          // >& and <& duplicate file descriptors, not filesystem paths.
          if (redirect.children.some(child => child.text === ">&" || child.text === "<&")) continue;
          redirects.push({ target: word(destination, vars), write: !/^\s*(?:\d+)?</.test(redirect.text) });
        }
        // Redirects belong to the statement that owns them; do not accidentally
        // attach them to the last command inside a $(...) expansion.
        const targets = commands.slice(start);
        const command = targets.find(item => body?.type === "command" && item.source === body.text) ?? targets.at(-1);
        if (command) { command.redirects.push(...redirects); command.heredoc ||= heredoc; }
        else if (redirects.length) commands.push({ source: node.text, words: [], redirects, heredoc });
        return;
      }
      default:
        unsupported(`shell construct ${node.type} requires an explicit approval`);
    }
  }

  visit(tree.rootNode, new Map([["HOME", process.env.HOME]]));
  return { commands, ...(reason ? { reason } : {}) };
}
