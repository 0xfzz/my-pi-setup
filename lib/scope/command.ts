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
  | { kind: "remove"; path: string }
  | { kind: "reset" }
  | { kind: "test"; path: string }
  | { kind: "yolo"; mode: "on" | "off" | "all" | "status"; persist: boolean }
  | { kind: "log"; limit: number }
  | { kind: "usage"; detail: string };

export const SCOPE_SUBCOMMANDS = [
  "status", "allow", "deny", "remove", "reset", "rules", "test", "yolo", "log",
] as const;

const USAGE = "Usage: /scope [status|allow <path> [--ro|--rw] [--project|--global]|deny <path> [--project|--global]|remove <path>|reset|rules|test <path>|yolo [on|off|all|status] [--persist]|log [n]]";

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
    const limit = Number.parseInt(rest[0] ?? "", 10);
    return { kind: "log", limit: Number.isFinite(limit) && limit > 0 ? Math.min(200, limit) : 20 };
  }

  if (command === "allow" || command === "deny" || command === "remove" || command === "test") {
    const flags = rest.filter(token => token.startsWith("--"));
    const paths = rest.filter(token => !token.startsWith("--"));
    const path = paths.join(" ");
    if (!path) return { kind: "usage", detail: `/scope ${command} needs a path.` };
    if (command === "remove" || command === "test") return { kind: command, path };
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
  lines.push(`  defaults: external=${state.defaults.external} unknown=${state.defaults.unknown}`);
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
    ...state.rules.map(rule => `  ${rule.action}  ${rule.resource}  ${rule.effect}${rule.source ? `  (${rule.source})` : ""}`),
  ];
}

export function decisionLine(decision: ScopeDecision): string {
  const source = decision.rule ? `rule ${decision.rule.action}:${decision.rule.resource}` : decision.root ? `root ${decision.root.path}` : "default";
  return `${decision.effect.toUpperCase()} — ${decision.reason} [${source}]`;
}
