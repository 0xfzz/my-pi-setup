import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SECTION_EVENT = "workflow-ui:section";
export const REFRESH_EVENT = "workflow-ui:refresh";
export interface SidebarSection {
  id: "todo" | "artifacts" | "mode" | "subagents" | "account" | "scope";
  title: string;
  tone?: "accent" | "warning" | "success";
  rows: string[];
  hint: string;
}
export interface SectionOffer { section: SidebarSection; handled: boolean }

/** Synchronous ownership handshake: legacy widgets remain when sidebar is absent. */
export function offerSection(pi: ExtensionAPI, section: SidebarSection): boolean {
  const offer: SectionOffer = { section, handled: false };
  pi.events?.emit(SECTION_EVENT, offer);
  return offer.handled;
}
