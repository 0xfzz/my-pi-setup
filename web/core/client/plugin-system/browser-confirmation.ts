/**
 * Operator confirmation for trusted browser code. Everything shown is a DOM
 * text node: a plugin-supplied name can never become markup in this dialog.
 */
import { browserGrantPromptText } from "../../protocol/browser-runtime.ts";

export interface BrowserGrantInfo {
  readonly id: string;
  readonly version: string;
  readonly sourcePath: string;
  readonly hash: string;
  readonly capabilities: readonly string[];
}

export type ConfirmBrowserHalf = (info: BrowserGrantInfo) => Promise<boolean>;

function button(doc: Document, label: string, className: string, onClick: () => void): HTMLButtonElement {
  const element = doc.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

/** Show the hash-bound prompt and resolve once the operator answers. */
export function confirmBrowserHalf(info: BrowserGrantInfo, doc: Document = document): Promise<boolean> {
  return new Promise((resolve) => {
    const panel = doc.createElement("div");
    panel.className = "browser-grant-dialog";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Browser code permission");
    panel.dataset.pluginId = info.id;

    const details = doc.createElement("pre");
    details.className = "browser-grant-details";
    details.textContent = browserGrantPromptText(info);
    panel.appendChild(details);

    const actions = doc.createElement("div");
    actions.className = "browser-grant-actions";
    const finish = (answer: boolean): void => {
      panel.remove();
      resolve(answer);
    };
    actions.appendChild(button(doc, "Allow browser code", "browser-grant-allow", () => finish(true)));
    actions.appendChild(button(doc, "Refuse", "browser-grant-refuse", () => finish(false)));
    panel.appendChild(actions);
    doc.body.appendChild(panel);
    panel.querySelector<HTMLButtonElement>(".browser-grant-allow")?.focus();
  });
}
