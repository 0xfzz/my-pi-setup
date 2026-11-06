"use client";

import React from "react";
import type { WebPluginDescriptor, WebView } from "@/lib/web-plugins-host";
import type { PluginSessionState } from "../PluginViewRenderer";
import { PluginAnchor } from "../PluginLayout";
export type SlotPosition = "top" | "center" | "bottom" | "floating";
export interface PluginWithViewAndSession { plugin: WebPluginDescriptor; view: WebView; sessionId: string }
export interface SlotHostProps {
  slot: SlotPosition; plugins: readonly WebPluginDescriptor[];
  views?: Record<string, Record<string, WebView>> | null;
  preferredSessionId?: string | null; sessions?: Record<string, PluginSessionState> | null;
}
export function resolvePluginViewAndSession(pluginId: string, views?: Record<string, Record<string, WebView>> | null, preferredSessionId?: string | null): { view: WebView; sessionId: string } | null {
  if (!views) return null;
  // A selected session with no data must never borrow another session's view.
  if (preferredSessionId) return views[preferredSessionId]?.[pluginId] ? { view: views[preferredSessionId][pluginId], sessionId: preferredSessionId } : null;
  for (const sessionId of Object.keys(views).sort()) if (views[sessionId]?.[pluginId]) return { view: views[sessionId][pluginId], sessionId };
  return null;
}
export function resolvePluginView(pluginId: string, views?: Record<string, Record<string, WebView>> | null, preferredSessionId?: string | null): WebView | null {
  return resolvePluginViewAndSession(pluginId, views, preferredSessionId)?.view ?? null;
}
/** Legacy slot API is a compatibility adapter over the shared layout coordinator. */
export function SlotHost({ slot, preferredSessionId }: SlotHostProps) { return <PluginAnchor region={slot} sessionId={preferredSessionId} />; }
