/**
 * The rows the `/scope` settings popup shows and the changes it can make.
 *
 * Pure, so the menu and `/scope status` describe the same state: a settings
 * screen that keeps its own copy of the scope would be a third source of truth,
 * which is exactly the confusion the popup exists to remove.
 *
 * The row shapes carry the facts a decision needs — where the entry lives, and
 * whether the user may remove it — so the popup never has to re-derive policy
 * while rendering.
 */
import { displayPath } from "./tool-paths.ts";
import type { ScopeAccess, ScopeEffect, ScopeRoot, ScopeRule, ScopeState } from "./types.ts";

export type DefaultKey = "external" | "readExternal";

/** Where a change is written: this session, this workspace, or every workspace. */
export type SettingsTarget = "session" | "project" | "global";

export const DEFAULT_LABELS: Record<DefaultKey, string> = {
  external: "write outside workspace",
  readExternal: "read outside workspace",
};

export function accessLabel(access: ScopeAccess): string {
  return access === "ro" ? "read-only" : "read-write";
}

export function yoloLabel(strength: ScopeAccess | undefined): string {
  if (strength === "ro") return "reads only";
  if (strength === "rw") return "reads and writes";
  return "off";
}

export interface GrantRow {
  kind: "grant";
  root: ScopeRoot;
  /** `workspace` for the built-in root, otherwise a readable path. */
  label: string;
  /** `read-write · project` */
  badge: string;
  /** The workspace itself: never removable, never re-saved. */
  builtin: boolean;
  /** Lives in a config file, so a change rewrites that file. */
  inConfig: boolean;
}

export interface RuleRow {
  kind: "rule";
  rule: ScopeRule;
  /** `<action>  <resource>  <effect>` */
  label: string;
  badge: string;
  inConfig: boolean;
}

export interface DefaultRow {
  kind: "default";
  key: DefaultKey;
  label: string;
  effect: ScopeEffect;
}

export interface YoloRow {
  kind: "yolo";
  strength: ScopeAccess | undefined;
  label: string;
}

export type SettingsRow = GrantRow | RuleRow | DefaultRow | YoloRow;

/** The sections, in the order the popup renders them. */
export const SETTINGS_SECTIONS = ["Grants", "Rules", "Defaults", "Yolo"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function sectionOf(row: SettingsRow): SettingsSection {
  if (row.kind === "grant") return "Grants";
  if (row.kind === "rule") return "Rules";
  if (row.kind === "default") return "Defaults";
  return "Yolo";
}

/** Every row the popup shows, in reading order. */
export function settingsRows(state: ScopeState, cwd: string): SettingsRow[] {
  const rows: SettingsRow[] = [];
  for (const root of state.roots) {
    const builtin = root.source === "session" && root.path === cwd;
    rows.push({
      kind: "grant",
      root,
      label: builtin ? "workspace" : displayPath(cwd, root.path),
      badge: `${accessLabel(root.access)} · ${root.source}`,
      builtin,
      inConfig: root.source === "project" || root.source === "global",
    });
  }
  for (const rule of state.rules) {
    rows.push({
      kind: "rule",
      rule,
      label: `${rule.action}  ${rule.resource}  ${rule.effect}`,
      badge: rule.source ?? "session",
      inConfig: rule.source === "project" || rule.source === "global",
    });
  }
  rows.push({ kind: "default", key: "external", label: DEFAULT_LABELS.external, effect: state.defaults.external });
  rows.push({ kind: "default", key: "readExternal", label: DEFAULT_LABELS.readExternal, effect: state.defaults.readExternal });
  rows.push({ kind: "yolo", strength: state.yolo?.strength, label: yoloLabel(state.yolo?.strength) });
  return rows;
}

/** A session/branch grant can be promoted to the workspace config. */
export function canKeepGrant(root: ScopeRoot): boolean {
  return root.source === "session" || root.source === "branch";
}

/** A session/branch rule can be promoted to the workspace config. */
export function canKeepRule(rule: ScopeRule): boolean {
  return !rule.source || rule.source === "session" || rule.source === "branch";
}

/** One change the popup asks the extension to make. */
export type SettingsAction =
  | { kind: "grant-access"; root: ScopeRoot; access: ScopeAccess }
  | { kind: "grant-keep"; root: ScopeRoot }
  | { kind: "grant-remove"; root: ScopeRoot }
  | { kind: "rule-effect"; rule: ScopeRule; effect: ScopeEffect }
  | { kind: "rule-keep"; rule: ScopeRule }
  | { kind: "rule-remove"; rule: ScopeRule }
  | { kind: "default"; key: DefaultKey; effect: ScopeEffect }
  | { kind: "yolo"; strength?: ScopeAccess }
  | { kind: "add-grant"; path: string; access: ScopeAccess; target: SettingsTarget }
  | { kind: "add-rule"; text: string; target: SettingsTarget };
