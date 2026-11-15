import { validateActionValues } from "./actions.ts";

export const WEB_PLUGIN_VIEW_EVENT = "web-plugin:view";

export const VIEW_MAX_ROWS = 200;
export const VIEW_MAX_CELL_CHARS = 500;
export const VIEW_MAX_BYTES = 65536;

/**
 * Markdown detail cells (list items, graph nodes) are readable documents, not
 * glance rows, so they get their own larger clamps. The host renders detail as
 * markdown through its own sanitising renderer — it is never HTML.
 */
export const VIEW_MAX_DETAIL_CHARS = 20_000;
export const VIEW_MAX_DETAIL_BYTES = 524_288;

export const GRAPH_MAX_NODES = 100;
export const GRAPH_MAX_EDGES = 200;
export const GRAPH_MAX_ID_CHARS = 200;

export const STATUS_TONES = ["neutral", "accent", "success", "warning", "danger"] as const;

export type StatusTone = (typeof STATUS_TONES)[number];

/** Lifecycle of a list item or graph node; the host renders it as an icon. */
export const LIST_STATUSES = ["pending", "active", "done", "blocked", "failed", "neutral"] as const;
export type ListStatus = (typeof LIST_STATUSES)[number];

export interface KvRow {
  label: string;
  value: string;
}

export interface KvWebView {
  type: "kv";
  title?: string;
  rows: KvRow[];
  omitted?: number;
}

export interface ListItem {
  text: string;
  status?: ListStatus;
  /** Markdown the host renders when the row is opened — never HTML. */
  detail?: string;
}

export interface ListWebView {
  type: "list";
  title?: string;
  /** Plain rows stay strings; a row needing an icon or an expandable body is a ListItem. */
  items: (string | ListItem)[];
  omitted?: number;
}

export interface StatusWebView {
  type: "status";
  tone: StatusTone;
  text: string;
}

/** A dialog action button; dispatches through the plugin action pipeline. */
export interface DialogAction {
  id: string;
  label: string;
  /** Visual weight; "primary" is the suggested confirm. */
  tone?: "default" | "primary" | "danger";
  /**
   * Submits the dialog's typed answer as the action value: the `input` text,
   * or every `fields` value as a name→value record. Only meaningful when the
   * dialog declares one of them; the host disables the action while a
   * required value is empty.
   */
  submitsInput?: boolean;
  /** Header actions sit beside the title; other actions remain in the footer. */
  placement?: "header" | "footer";
}

/** A selectable row whose action belongs to the publishing plugin. */
export interface DialogItem {
  id: string;
  label: string;
  detail?: string;
  actionId: string;
  values?: Record<string, string>;
}

/** What a dialog field collects. */
export const DIALOG_FIELD_KINDS = ["text", "secret", "select"] as const;
export type DialogFieldKind = (typeof DIALOG_FIELD_KINDS)[number];

/**
 * One field of a dialog form.
 *
 * A form is what makes a multi-step dialog possible: the extension publishes
 * one step (its fields, its labels, its help) and receives the submitted
 * values back through the action pipeline, so the wizard's state lives in the
 * extension rather than in the host. Nothing here is provider- or
 * command-specific — any extension that needs more than one typed answer uses
 * the same shape.
 */
export interface DialogField {
  /** Key this field's value is submitted under. */
  name: string;
  label: string;
  kind?: DialogFieldKind;
  /** Pre-filled value. A `secret` field may not carry one. */
  value?: string;
  placeholder?: string;
  /** One line of guidance, rendered under the field. */
  help?: string;
  /** The options of a `select`; ignored by the other kinds. */
  choices?: string[];
  /** The host refuses to submit while this field is empty. */
  required?: boolean;
}

/** A form stays small enough to read on one screen. */
/** A dialog id is an identity, not prose: no spaces, no separators beyond ":" and "-". */
export const DIALOG_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,119}$/;

export const DIALOG_MAX_FIELDS = 12;
export const DIALOG_MAX_FIELD_CHOICES = 40;
export const DIALOG_FIELD_NAME_REGEX = /^[a-z][a-zA-Z0-9_-]*$/;

/**
 * A modal dialog — the extension surface for web popups. The body is
 * markdown (rendered by the host's sanitising renderer, never HTML);
 * actions route back through the plugin action pipeline with the plugin id
 * and action id, so an extension can ask, answer, and clear by publishing
 * the view again with `open: false`.
 */
export interface DialogWebView {
  type: "dialog";
  /**
   * Stable identity of this dialog. A publisher that reuses the id keeps the
   * user's typed answer (a refusal corrected in place); a new id is a new
   * dialog, which is how a wizard advances step by step. Defaults to the
   * publishing plugin's id.
   */
  id?: string;
  title?: string;
  /** Markdown body. */
  body?: string;
  /** Plain-line body when markdown is overkill. */
  lines?: string[];
  actions?: DialogAction[];
  /** Selectable rows, independent of the small footer action bar. */
  items?: DialogItem[];
  /**
   * A single-line typed answer. `submitsInput` actions carry the text as
   * the action value; Enter submits the first (or primary) one.
   */
  input?: {
    placeholder?: string;
  };
  /**
   * A form: several typed answers submitted together. `submitsInput` actions
   * carry them as a name→value record; Enter submits the first (or primary)
   * one, exactly like `input`. A dialog declares `input` or `fields`, not
   * both — one place for the answer keeps the submit path unambiguous.
   */
  fields?: DialogField[];
  /** `true` (default) shows the dialog; `false` closes it. */
  open?: boolean;
}

export type WebView = KvWebView | ListWebView | StatusWebView | GraphWebView | DialogWebView;

/** What a node is in the graph; the host groups and styles by it. */
export const GRAPH_NODE_KINDS = ["parent", "child", "review", "escalation"] as const;
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

export interface GraphNode {
  /** Stable within one view; edges reference it. */
  id: string;
  label: string;
  status?: ListStatus;
  kind?: GraphNodeKind;
  detail?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}

export interface GraphWebView {
  type: "graph";
  title?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  omitted?: number;
}

export type ValidateViewResult =
  | { ok: true; view: WebView; warnings?: string[] }
  | { ok: false; error: string };

function clampCell(text: string, fieldName: string, warnings: string[]): string {
  if (text.length <= VIEW_MAX_CELL_CHARS) {
    return text;
  }
  warnings.push(`${fieldName} truncated to ${VIEW_MAX_CELL_CHARS} characters`);
  return text.slice(0, VIEW_MAX_CELL_CHARS - 1) + "…";
}

/** Detail cells are documents: a larger clamp, but still visibly truncated. */
function clampDetail(text: string, fieldName: string, warnings: string[]): string {
  if (text.length <= VIEW_MAX_DETAIL_CHARS) {
    return text;
  }
  warnings.push(`${fieldName} truncated to ${VIEW_MAX_DETAIL_CHARS} characters`);
  return text.slice(0, VIEW_MAX_DETAIL_CHARS - 1) + "…";
}

/** Node ids are structural, so truncation keeps them referenceable, not pretty. */
function clampId(text: string, fieldName: string, warnings: string[]): string {
  if (text.length <= GRAPH_MAX_ID_CHARS) {
    return text;
  }
  warnings.push(`${fieldName} truncated to ${GRAPH_MAX_ID_CHARS} characters`);
  return text.slice(0, GRAPH_MAX_ID_CHARS);
}

/** Rows use the same payload ceiling and unsafe-key checks as button actions. */
function validateDialogItems(input: unknown): { items?: DialogItem[] } | { error: string } {
  if (input === undefined) return {};
  if (!Array.isArray(input) || input.length > VIEW_MAX_ROWS) return { error: "dialog items must be a bounded array" };
  const items: DialogItem[] = [];
  const ids = new Set<string>();
  for (const row of input) {
    if (row === null || typeof row !== "object" || typeof row.id !== "string"
      || typeof row.label !== "string" || typeof row.actionId !== "string"
      || (row.detail !== undefined && typeof row.detail !== "string")) {
      return { error: "dialog items need id, label, actionId and optional detail strings" };
    }
    const id = row.id.slice(0, VIEW_MAX_CELL_CHARS);
    if (!id.trim() || !row.label.trim() || !row.actionId.trim() || ids.has(id)) {
      return { error: "dialog items need nonempty labels/actions and unique nonempty IDs" };
    }
    ids.add(id);
    const values = validateActionValues(row.values);
    if (!values.ok) return { error: values.error };
    items.push({
      id,
      label: row.label.slice(0, VIEW_MAX_CELL_CHARS),
      actionId: row.actionId.slice(0, VIEW_MAX_CELL_CHARS),
      ...(row.detail !== undefined ? { detail: row.detail.slice(0, VIEW_MAX_CELL_CHARS) } : {}),
      ...(values.values !== undefined ? { values: values.values } : {}),
    });
  }
  return { items };
}

/**
 * Validate a dialog form.
 *
 * Two rules are structural rather than cosmetic: a `secret` field may not
 * carry a value (a pre-filled credential would be re-published on every
 * render, so it would live in the event stream and the browser), and a
 * `select` needs its choices (a menu with nothing to pick is a dead end).
 */
function validateDialogFields(
  input: unknown,
  warnings: string[],
): { fields?: DialogField[] } | { error: string } {
  if (input === undefined) return {};
  if (!Array.isArray(input)) return { error: "dialog fields must be an array" };
  if (input.length > DIALOG_MAX_FIELDS) {
    return { error: `dialog fields cannot exceed ${DIALOG_MAX_FIELDS} fields (got ${input.length})` };
  }
  const fields: DialogField[] = [];
  const seen = new Set<string>();
  for (const [index, item] of input.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { error: `dialog field at index ${index} must be an object` };
    }
    const raw = item as Record<string, unknown>;
    if (typeof raw.name !== "string" || !DIALOG_FIELD_NAME_REGEX.test(raw.name)) {
      return { error: `dialog field at index ${index}: name must match ${String(DIALOG_FIELD_NAME_REGEX)}` };
    }
    if (seen.has(raw.name)) return { error: `dialog field "${raw.name}" is declared twice` };
    seen.add(raw.name);
    if (typeof raw.label !== "string" || raw.label.trim() === "") {
      return { error: `dialog field "${raw.name}": label is missing or empty` };
    }
    const kind = raw.kind === undefined ? "text" : raw.kind;
    if (!DIALOG_FIELD_KINDS.includes(kind as DialogFieldKind)) {
      return { error: `dialog field "${raw.name}": unknown kind ${String(raw.kind)}` };
    }
    const choices = validateFieldChoices(raw.name, kind as DialogFieldKind, raw.choices, warnings);
    if ("error" in choices) return { error: choices.error };
    if (kind === "secret" && typeof raw.value === "string" && raw.value !== "") {
      return { error: `dialog field "${raw.name}": a secret field cannot carry a value` };
    }
    fields.push({
      name: raw.name,
      label: clampCell(raw.label, `Dialog field "${raw.name}" label`, warnings),
      ...(raw.kind !== undefined ? { kind: kind as DialogFieldKind } : {}),
      ...(typeof raw.value === "string"
        ? { value: clampDetail(raw.value, `Dialog field "${raw.name}" value`, warnings) }
        : {}),
      ...(typeof raw.placeholder === "string"
        ? { placeholder: clampCell(raw.placeholder, `Dialog field "${raw.name}" placeholder`, warnings) }
        : {}),
      ...(typeof raw.help === "string"
        ? { help: clampCell(raw.help, `Dialog field "${raw.name}" help`, warnings) }
        : {}),
      ...(choices.choices !== undefined ? { choices: choices.choices } : {}),
      ...(raw.required === true ? { required: true } : {}),
    });
  }
  return { fields };
}

function validateFieldChoices(
  name: string,
  kind: DialogFieldKind,
  input: unknown,
  warnings: string[],
): { choices?: string[] } | { error: string } {
  if (input === undefined) {
    return kind === "select" ? { error: `dialog field "${name}": a select needs choices` } : {};
  }
  if (!Array.isArray(input) || input.some((choice) => typeof choice !== "string" || choice === "")) {
    return { error: `dialog field "${name}": choices must be an array of non-empty strings` };
  }
  if (input.length > DIALOG_MAX_FIELD_CHOICES) {
    return { error: `dialog field "${name}": choices cannot exceed ${DIALOG_MAX_FIELD_CHOICES} entries` };
  }
  return {
    choices: input.map((choice: string, index) =>
      clampCell(choice, `Dialog field "${name}" choice ${index}`, warnings)
    ),
  };
}

function byteLength(obj: unknown): number {
  return new TextEncoder().encode(JSON.stringify(obj)).length;
}

export function validateView(input: unknown): ValidateViewResult {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { ok: false, error: "View must be a non-null object" };
    }

    const raw = input as Record<string, unknown>;
    if (typeof raw.type !== "string") {
      return { ok: false, error: "View type must be a string" };
    }

    const warnings: string[] = [];

    let cleanTitle: string | undefined;
    if (raw.title !== undefined) {
      if (typeof raw.title !== "string") {
        return { ok: false, error: "View title must be a string" };
      }
      cleanTitle = clampCell(raw.title, "Title", warnings);
    }

    if (raw.type === "status") {
      if (typeof raw.tone !== "string" || !STATUS_TONES.includes(raw.tone as StatusTone)) {
        return { ok: false, error: `Invalid status tone: ${String(raw.tone)}` };
      }
      if (typeof raw.text !== "string") {
        return { ok: false, error: "Status text must be a string" };
      }
      const cleanText = clampCell(raw.text, "Status text", warnings);
      const view: StatusWebView = {
        type: "status",
        tone: raw.tone as StatusTone,
        text: cleanText,
      };
      return {
        ok: true,
        view,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    if (raw.type === "dialog") {
      if (raw.body !== undefined && typeof raw.body !== "string") {
        return { ok: false, error: "dialog body must be a string" };
      }
      if (raw.id !== undefined && (typeof raw.id !== "string" || !DIALOG_ID_REGEX.test(raw.id))) {
        return { ok: false, error: `dialog id must match ${String(DIALOG_ID_REGEX)}` };
      }
      if (raw.lines !== undefined) {
        if (!Array.isArray(raw.lines) || raw.lines.some((line) => typeof line !== "string")) {
          return { ok: false, error: "dialog lines must be an array of strings" };
        }
      }
      // A dialog needs SOMETHING to show or close: body, lines, or actions.
      // A bodyless close ({open: false}) and an actions-only picker are
      // both legitimate shapes.
      if (
        raw.body === undefined
        && raw.lines === undefined
        && raw.fields === undefined
        && raw.items === undefined
        && (raw.actions === undefined || (Array.isArray(raw.actions) && raw.actions.length === 0))
        && raw.open !== false
      ) {
        return { ok: false, error: "dialog needs a body, lines, fields, or actions" };
      }
      if (raw.actions !== undefined) {
        if (!Array.isArray(raw.actions) || raw.actions.length > 8) {
          return { ok: false, error: "dialog actions must be an array of at most 8" };
        }
        for (const action of raw.actions) {
          if (
            typeof action !== "object"
            || action === null
            || typeof action.id !== "string"
            || typeof action.label !== "string"
            || (action.tone !== undefined && !["default", "primary", "danger"].includes(action.tone))
            || (action.submitsInput !== undefined && typeof action.submitsInput !== "boolean")
            || (action.placement !== undefined && !["header", "footer"].includes(action.placement))
          ) {
            return { ok: false, error: "dialog actions must be {id, label, tone?, submitsInput?, placement?}" };
          }
        }
      }
      const items = validateDialogItems(raw.items);
      if ("error" in items) return { ok: false, error: items.error };
      if (raw.input !== undefined) {
        if (
          typeof raw.input !== "object"
          || raw.input === null
          || Array.isArray(raw.input)
          || (raw.input as { placeholder?: unknown }).placeholder !== undefined
          && typeof (raw.input as { placeholder?: unknown }).placeholder !== "string"
        ) {
          return { ok: false, error: "dialog input must be {placeholder?} with a string placeholder" };
        }
      }
      if (raw.fields !== undefined && raw.input !== undefined) {
        return { ok: false, error: "dialog declares input or fields, not both" };
      }
      const fields = validateDialogFields(raw.fields, warnings);
      if ("error" in fields) return { ok: false, error: fields.error };
      const view: DialogWebView = {
        type: "dialog",
        ...(raw.id !== undefined ? { id: clampId(raw.id as string, "Dialog id", warnings) } : {}),
        ...(cleanTitle !== undefined ? { title: cleanTitle } : {}),
        ...(raw.body !== undefined ? { body: clampDetail(raw.body, "Dialog body", warnings) } : {}),
        ...(raw.lines !== undefined
          ? { lines: raw.lines.slice(0, VIEW_MAX_ROWS).map((line: string, index: number) => clampCell(line, `Dialog line ${index}`, warnings)) }
          : {}),
        ...(raw.actions !== undefined
          ? {
            actions: raw.actions.map(
              (action: DialogAction) => ({
                id: clampId(action.id, "Action id", warnings),
                label: clampCell(action.label, "Action label", warnings),
                ...(action.tone !== undefined ? { tone: action.tone as DialogAction["tone"] } : {}),
                ...(action.submitsInput !== undefined ? { submitsInput: action.submitsInput } : {}),
                ...(action.placement !== undefined ? { placement: action.placement } : {}),
              }),
            ),
          }
          : {}),
        ...(raw.input !== undefined
          ? {
            input: (raw.input as { placeholder?: string }).placeholder !== undefined
              ? { placeholder: clampCell((raw.input as { placeholder?: string }).placeholder!, "Dialog input placeholder", warnings) }
              : {},
          }
          : {}),
        ...(fields.fields !== undefined ? { fields: fields.fields } : {}),
        ...(items.items !== undefined ? { items: items.items } : {}),
        open: raw.open !== false,
      };
      return {
        ok: true,
        view,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    if (raw.type === "kv") {
      if (!Array.isArray(raw.rows)) {
        return { ok: false, error: "kv rows must be an array" };
      }

      for (let i = 0; i < raw.rows.length; i++) {
        const row = raw.rows[i];
        if (typeof row !== "object" || row === null || Array.isArray(row)) {
          return { ok: false, error: `kv row at index ${i} must be an object` };
        }
        if (typeof row.label !== "string" || typeof row.value !== "string") {
          return { ok: false, error: `kv row at index ${i} label and value must be strings` };
        }
      }

      let rows: KvRow[] = raw.rows.map((row: { label: string; value: string }, idx: number) => ({
        label: clampCell(row.label, `Row ${idx} label`, warnings),
        value: clampCell(row.value, `Row ${idx} value`, warnings),
      }));

      let omitted =
        typeof raw.omitted === "number" && Number.isFinite(raw.omitted) && raw.omitted > 0
          ? Math.floor(raw.omitted)
          : 0;

      if (rows.length > VIEW_MAX_ROWS) {
        const excess = rows.length - VIEW_MAX_ROWS;
        omitted += excess;
        rows = rows.slice(0, VIEW_MAX_ROWS);
        warnings.push(`Rows capped at ${VIEW_MAX_ROWS} (${excess} omitted)`);
      }

      let candidate: KvWebView = {
        type: "kv",
        ...(cleanTitle !== undefined ? { title: cleanTitle } : {}),
        rows,
        ...(omitted > 0 ? { omitted } : {}),
      };

      const hadInitialByteFit = byteLength(candidate) > VIEW_MAX_BYTES;
      while (byteLength(candidate) > VIEW_MAX_BYTES && rows.length > 0) {
        const dropCount = Math.max(1, Math.ceil(rows.length * 0.1));
        rows = rows.slice(0, rows.length - dropCount);
        omitted += dropCount;
        candidate = {
          type: "kv",
          ...(cleanTitle !== undefined ? { title: cleanTitle } : {}),
          rows,
          omitted,
        };
      }

      if (byteLength(candidate) > VIEW_MAX_BYTES) {
        return { ok: false, error: `View exceeds maximum size of ${VIEW_MAX_BYTES} bytes` };
      }

      if (hadInitialByteFit) {
        warnings.push(`View serialised size exceeded ${VIEW_MAX_BYTES} bytes; omitted rows`);
      }

      return {
        ok: true,
        view: candidate,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    if (raw.type === "list") {
      if (!Array.isArray(raw.items)) {
        return { ok: false, error: "list items must be an array" };
      }

      let hasDetail = false;
      const items: (string | ListItem)[] = [];
      for (let i = 0; i < raw.items.length; i++) {
        const item = raw.items[i];
        if (typeof item === "string") {
          items.push(clampCell(item, `Item ${i}`, warnings));
          continue;
        }
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          return { ok: false, error: `list item at index ${i} must be a string or an item object` };
        }
        const entry = item as Record<string, unknown>;
        if (!Object.keys(entry).every(key => ["text", "status", "detail"].includes(key))) {
          return { ok: false, error: `list item at index ${i} may only carry text, status and detail` };
        }
        if (typeof entry.text !== "string") {
          return { ok: false, error: `list item at index ${i} text must be a string` };
        }
        if (entry.status !== undefined && !LIST_STATUSES.includes(entry.status as ListStatus)) {
          return { ok: false, error: `list item at index ${i} has unknown status "${String(entry.status)}"` };
        }
        if (entry.detail !== undefined && typeof entry.detail !== "string") {
          return { ok: false, error: `list item at index ${i} detail must be a string` };
        }
        hasDetail ||= entry.detail !== undefined;
        items.push({
          text: clampCell(entry.text, `Item ${i}`, warnings),
          ...(entry.status !== undefined ? { status: entry.status as ListStatus } : {}),
          ...(entry.detail !== undefined ? { detail: clampDetail(entry.detail, `Item ${i} detail`, warnings) } : {}),
        });
      }

      let omitted =
        typeof raw.omitted === "number" && Number.isFinite(raw.omitted) && raw.omitted > 0
          ? Math.floor(raw.omitted)
          : 0;

      if (items.length > VIEW_MAX_ROWS) {
        const excess = items.length - VIEW_MAX_ROWS;
        omitted += excess;
        items.splice(VIEW_MAX_ROWS);
        warnings.push(`Items capped at ${VIEW_MAX_ROWS} (${excess} omitted)`);
      }

      // A detail-bearing view is a readable document and gets the document cap.
      const byteCap = hasDetail ? VIEW_MAX_DETAIL_BYTES : VIEW_MAX_BYTES;

      let candidate: ListWebView = {
        type: "list",
        ...(cleanTitle !== undefined ? { title: cleanTitle } : {}),
        items,
        ...(omitted > 0 ? { omitted } : {}),
      };

      const wasInitiallyOver = byteLength(candidate) > byteCap;
      while (byteLength(candidate) > byteCap && items.length > 0) {
        const dropCount = Math.max(1, Math.ceil(items.length * 0.1));
        items.splice(items.length - dropCount, dropCount);
        omitted += dropCount;
        candidate = {
          type: "list",
          ...(cleanTitle !== undefined ? { title: cleanTitle } : {}),
          items,
          omitted,
        };
      }

      if (byteLength(candidate) > byteCap) {
        return { ok: false, error: `View exceeds maximum size of ${byteCap} bytes` };
      }

      if (wasInitiallyOver) {
        warnings.push(`View serialised size exceeded ${byteCap} bytes; omitted items`);
      }

      return {
        ok: true,
        view: candidate,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    if (raw.type === "graph") {
      if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
        return { ok: false, error: "graph nodes and edges must be arrays" };
      }

      let hasDetail = false;
      let nodes: GraphNode[] = [];
      const ids = new Set<string>();
      for (let i = 0; i < raw.nodes.length; i++) {
        const node = raw.nodes[i];
        if (typeof node !== "object" || node === null || Array.isArray(node)) {
          return { ok: false, error: `graph node at index ${i} must be an object` };
        }
        const entry = node as Record<string, unknown>;
        if (!Object.keys(entry).every(key => ["id", "label", "status", "kind", "detail"].includes(key))) {
          return { ok: false, error: `graph node at index ${i} may only carry id, label, status, kind and detail` };
        }
        if (typeof entry.id !== "string" || !entry.id.trim()) {
          return { ok: false, error: `graph node at index ${i} id must be a non-empty string` };
        }
        if (typeof entry.label !== "string") {
          return { ok: false, error: `graph node at index ${i} label must be a string` };
        }
        if (entry.status !== undefined && !LIST_STATUSES.includes(entry.status as ListStatus)) {
          return { ok: false, error: `graph node at index ${i} has unknown status "${String(entry.status)}"` };
        }
        if (entry.kind !== undefined && !GRAPH_NODE_KINDS.includes(entry.kind as GraphNodeKind)) {
          return { ok: false, error: `graph node at index ${i} has unknown kind "${String(entry.kind)}"` };
        }
        if (entry.detail !== undefined && typeof entry.detail !== "string") {
          return { ok: false, error: `graph node at index ${i} detail must be a string` };
        }
        const id = clampId(entry.id, `Node ${i} id`, warnings);
        if (ids.has(id)) {
          return { ok: false, error: `graph node at index ${i} repeats node id "${id}"` };
        }
        ids.add(id);
        hasDetail ||= entry.detail !== undefined;
        nodes.push({
          id,
          label: clampCell(entry.label, `Node ${i} label`, warnings),
          ...(entry.status !== undefined ? { status: entry.status as ListStatus } : {}),
          ...(entry.kind !== undefined ? { kind: entry.kind as GraphNodeKind } : {}),
          ...(entry.detail !== undefined ? { detail: clampDetail(entry.detail, `Node ${i} detail`, warnings) } : {}),
        });
      }

      let edges: GraphEdge[] = [];
      for (let i = 0; i < raw.edges.length; i++) {
        const edge = raw.edges[i];
        if (typeof edge !== "object" || edge === null || Array.isArray(edge)) {
          return { ok: false, error: `graph edge at index ${i} must be an object` };
        }
        const entry = edge as Record<string, unknown>;
        if (!Object.keys(entry).every(key => ["from", "to", "label"].includes(key))) {
          return { ok: false, error: `graph edge at index ${i} may only carry from, to and label` };
        }
        if (typeof entry.from !== "string" || !entry.from.trim() || typeof entry.to !== "string" || !entry.to.trim()) {
          return { ok: false, error: `graph edge at index ${i} from and to must be non-empty strings` };
        }
        if (entry.label !== undefined && typeof entry.label !== "string") {
          return { ok: false, error: `graph edge at index ${i} label must be a string` };
        }
        const from = clampId(entry.from, `Edge ${i} from`, warnings);
        const to = clampId(entry.to, `Edge ${i} to`, warnings);
        if (!ids.has(from) || !ids.has(to)) {
          return { ok: false, error: `graph edge at index ${i} references a node this view does not declare` };
        }
        edges.push({
          from,
          to,
          ...(entry.label !== undefined ? { label: clampCell(entry.label, `Edge ${i} label`, warnings) } : {}),
        });
      }

      let omitted =
        typeof raw.omitted === "number" && Number.isFinite(raw.omitted) && raw.omitted > 0
          ? Math.floor(raw.omitted)
          : 0;

      if (nodes.length > GRAPH_MAX_NODES) {
        const excess = nodes.length - GRAPH_MAX_NODES;
        omitted += excess;
        nodes = nodes.slice(0, GRAPH_MAX_NODES);
        warnings.push(`Nodes capped at ${GRAPH_MAX_NODES} (${excess} omitted)`);
      }
      // A capped node leaves dangling edges: drop them too, and count them,
      // so every edge in the published view references a declared node.
      {
        const keptIds = new Set(nodes.map(node => node.id));
        const connected = edges.filter(edge => keptIds.has(edge.from) && keptIds.has(edge.to));
        if (connected.length !== edges.length) {
          omitted += edges.length - connected.length;
          edges = connected;
        }
      }
      if (edges.length > GRAPH_MAX_EDGES) {
        const excess = edges.length - GRAPH_MAX_EDGES;
        omitted += excess;
        edges = edges.slice(0, GRAPH_MAX_EDGES);
        warnings.push(`Edges capped at ${GRAPH_MAX_EDGES} (${excess} omitted)`);
      }

      const byteCap = hasDetail ? VIEW_MAX_DETAIL_BYTES : VIEW_MAX_BYTES;
      const liveIds = () => new Set(nodes.map(node => node.id));

      let candidate: GraphWebView = {
        type: "graph",
        ...(cleanTitle !== undefined ? { title: cleanTitle } : {}),
        nodes,
        edges,
        ...(omitted > 0 ? { omitted } : {}),
      };

      const wasInitiallyOver = byteLength(candidate) > byteCap;
      while (byteLength(candidate) > byteCap && nodes.length > 0) {
        // Drop trailing nodes and the edges that referenced them, as list rows.
        const dropCount = Math.max(1, Math.ceil(nodes.length * 0.1));
        nodes = nodes.slice(0, nodes.length - dropCount);
        const kept = liveIds();
        edges = edges.filter(edge => kept.has(edge.from) && kept.has(edge.to));
        omitted += dropCount;
        candidate = {
          type: "graph",
          ...(cleanTitle !== undefined ? { title: cleanTitle } : {}),
          nodes,
          edges,
          omitted,
        };
      }

      if (byteLength(candidate) > byteCap) {
        return { ok: false, error: `View exceeds maximum size of ${byteCap} bytes` };
      }

      if (wasInitiallyOver) {
        warnings.push(`View serialised size exceeded ${byteCap} bytes; omitted nodes`);
      }

      return {
        ok: true,
        view: candidate,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    return { ok: false, error: `Unknown view type: ${raw.type}` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
