/**
 * `/scope` parsing and reporting, kept pure so the command can be tested
 * without a Pi session, a terminal or a config file on disk.
 *
 * The command only names what the gate already models: roots (with access),
 * rules, the two defaults, and the yolo arm. Anything else is a usage error
 * rather than a guess.
 */
import { displayPath } from "./tool-paths.ts";
import type { ScopeAccess, ScopeDecision, ScopeRoot, ScopeState } from "./types.ts";

export type ScopeTarget = "session" | "project" | "global";

export type ScopeAction =
  | { kind: "status" }
  | { kind: "rules" }
  | { kind: "allow"; path: string; access: ScopeAccess; target: ScopeTarget }
  | { kind: "deny"; path: string; target: ScopeTarget }
  | { kind: "remove"; path: string; target: ScopeTarget }
  /** Revoke one rule by name: `<tool|*> <glob>`, session or persisted. */
  | { kind: "remove-rule"; action: string; resource: string; target: ScopeTarget }
  | { kind: "reset" }
  | { kind: "test"; path: string }
  | { kind: "yolo"; mode: "on" | "off" | "all" | "status"; persist: boolean }
  | { kind: "log"; limit: number; stats?: boolean }
  | { kind: "usage"; detail: string };

export const SCOPE_SUBCOMMANDS = [
  "status", "allow", "deny", "remove", "reset", "rules", "test", "yolo", "log",
] as const;

const USAGE = "Usage: /scope [status|allow <path> [--ro|--rw] [--project|--global]|deny <path> [--project|--global]|remove [--rule] <path|action glob> [--project|--global]|reset|rules|test <path>|yolo [on|off|all|status] [--persist]|log [n] [--stats]]";

const EFFECTS: ReadonlySet<string> = new Set(["allow", "ask", "deny"]);

export function usage(detail = ""): string {
  return detail ? `${detail}\n${USAGE}` : USAGE;
}

function target(flags: readonly string[]): ScopeTarget {
  if (flags.includes("--global")) return "global";
  if (flags.includes("--project")) return "project";
  return "session";
}

export function parseScopeCommand(input: string): ScopeAction {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const [command, ...rest] = tokens;
  if (!command || command === "status") return { kind: "status" };

  if (command === "rules") return { kind: "rules" };
  if (command === "reset") return { kind: "reset" };
  if (command === "log") {
    const stats = rest.includes("--stats");
    const limit = Number.parseInt(rest.find(token => !token.startsWith("--")) ?? "", 10);
    return { kind: "log", limit: Number.isFinite(limit) && limit > 0 ? Math.min(200, limit) : 20, ...(stats ? { stats } : {}) };
  }

  if (command === "remove") {
    const flags = rest.filter(token => token.startsWith("--"));
    const words = rest.filter(token => !token.startsWith("--"));
    if (flags.includes("--rule")) {
      // The glob may contain spaces (`rm -rf *`), so only the first word is the
      // action and everything after it is the resource. A row pasted straight
      // from `/scope rules` ends in its effect; tolerate that instead of failing
      // to match a rule the user just read off the screen.
      const [action, ...resourceParts] = words;
      if (resourceParts.length > 1 && EFFECTS.has(resourceParts[resourceParts.length - 1]!)) resourceParts.pop();
      const resource = resourceParts.join(" ");
      if (!action || !resource) {
        return { kind: "usage", detail: "Pick the rule to remove: /scope remove --rule <tool|*> <glob>." };
      }
      return { kind: "remove-rule", action, resource, target: target(flags) };
    }
    const path = words.join(" ");
    if (!path) return { kind: "usage", detail: "/scope remove needs a path, or --rule <tool|*> <glob>." };
    return { kind: "remove", path, target: target(flags) };
  }

  if (command === "allow" || command === "deny" || command === "test") {
    const flags = rest.filter(token => token.startsWith("--"));
    const paths = rest.filter(token => !token.startsWith("--"));
    const path = paths.join(" ");
    if (!path) return { kind: "usage", detail: `/scope ${command} needs a path.` };
    if (command === "test") return { kind: command, path };
    if (flags.includes("--ro") && flags.includes("--rw")) {
      return { kind: "usage", detail: "Pick one of --ro or --rw, not both." };
    }
    if (command === "deny") return { kind: "deny", path, target: target(flags) };
    const access: ScopeAccess = flags.includes("--ro") ? "ro" : "rw";
    return { kind: "allow", path, access, target: target(flags) };
  }

  if (command === "yolo") {
    const flags = rest.filter(token => token.startsWith("--"));
    const mode = rest.find(token => !token.startsWith("--")) ?? "on";
    if (mode !== "on" && mode !== "off" && mode !== "all" && mode !== "status") {
      return { kind: "usage", detail: `Unknown yolo mode "${mode}".` };
    }
    return { kind: "yolo", mode, persist: flags.includes("--persist") };
  }

  return { kind: "usage", detail: `Unknown subcommand "${command}".` };
}

/** Argument completions for the slash command. */
export function scopeCompletions(prefix: string): Array<{ value: string; label: string }> {
  const value = prefix.trimStart();
  if (!value || !value.includes(" ")) {
    return SCOPE_SUBCOMMANDS
      .filter(name => name.startsWith(value))
      .map(name => ({ value: name, label: name }));
  }
  const [command, ...rest] = value.split(/\s+/);
  if (!["allow", "deny", "remove", "test"].includes(command ?? "")) return [];
  const seen = rest.join(" ");
  if (!seen.startsWith("--") && seen.length > 0) return [];
  return ["--ro", "--rw", "--project", "--global"]
    .filter(flag => flag.startsWith(seen))
    .map(flag => ({ value: `${command} ${flag}`, label: flag }));
}

export function describeRoot(root: ScopeRoot, cwd: string): string {
  const where = root.source === "session" && root.path === cwd ? "workspace" : displayPath(cwd, root.path);
  return `${where}  ${root.access}  (${root.source})`;
}

export function statusLines(state: ScopeState, cwd: string, sources: readonly string[]): string[] {
  const lines = ["Scope", ...state.roots.map(root => `  ${describeRoot(root, cwd)}`)];
  lines.push(`  defaults: write-outside=${state.defaults.external} read-outside=${state.defaults.readExternal} unknown=${state.defaults.unknown}`);
  if (state.yolo) {
    lines.push(`  yolo: ${state.yolo.strength}${state.yolo.persist ? " (persisted)" : ""} — /scope yolo off to disarm`);
  }
  lines.push(`  rules: ${state.rules.length}`);
  if (sources.length) lines.push(`  config: ${sources.join(", ")}`);
  return lines;
}

export function ruleLines(state: ScopeState): string[] {
  if (!state.rules.length) return ["Scope rules: none"];
  return [
    "Scope rules (last match wins)",
    // Numbered so a rule can be copied straight into `/scope remove --rule`.
    ...state.rules.map((rule, index) =>
      `  ${index + 1}  ${rule.action}  ${rule.resource}  ${rule.effect}${rule.source ? `  (${rule.source})` : ""}`),
  ];
}

export function decisionLine(decision: ScopeDecision): string {
  const source = decision.rule ? `rule ${decision.rule.action}:${decision.rule.resource}` : decision.root ? `root ${decision.root.path}` : "default";
  return `${decision.effect.toUpperCase()} — ${decision.reason} [${source}]`;
}
