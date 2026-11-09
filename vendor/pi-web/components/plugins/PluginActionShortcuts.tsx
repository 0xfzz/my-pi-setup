"use client";

import { useEffect, useRef, useState } from "react";
import { usePluginData } from "./PluginViewRenderer";
import { actionKeybindingMatches, isEditableTarget, postPluginAction } from "./actionClient";
import type { WebPluginDescriptor } from "@/lib/web-plugins-host";

/**
 * Keyboard shortcuts for instant plugin actions (no declared confirm), per the
 * plugin-actions PRD. Bindings are descriptor data; the host owns dispatch, and
 * a shortcut never fires while the user is typing in a field.
 */
export function PluginActionShortcuts({ sessionId }: { sessionId?: string | null }) {
  const data = usePluginData();
  const [feedback, setFeedback] = useState<{ actionTitle: string; error?: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const pluginsRef = useRef(data.plugins);
  pluginsRef.current = data.plugins;

  useEffect(() => {
    const bindings: { plugin: WebPluginDescriptor; action: { id: string; title: string; keybinding: string } }[] = [];
    for (const plugin of data.plugins) {
      for (const action of plugin.actions ?? []) {
        // Only instant actions bind keys: a confirmed action cannot be typed
        // from a shortcut, and the POST would 403 without its string.
        if (action.keybinding && action.confirm === undefined) {
          bindings.push({ plugin, action: { id: action.id, title: action.title, keybinding: action.keybinding } });
        }
      }
    }
    if (!bindings.length) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      const binding = bindings.find(candidate => actionKeybindingMatches(candidate.action.keybinding, event));
      if (!binding) return;
      event.preventDefault();
      const sid = sessionIdRef.current;
      if (!sid) {
        setFeedback({ actionTitle: binding.action.title, error: "No active session" });
        return;
      }
      void postPluginAction(sid, binding.plugin.id, binding.action).then(outcome => {
        if (outcome.data.ok) setFeedback({ actionTitle: binding.action.title });
        else setFeedback({ actionTitle: binding.action.title, error: outcome.data.error ?? `Action failed (${outcome.status})` });
      }).catch(error => {
        setFeedback({ actionTitle: binding.action.title, error: error instanceof Error ? error.message : String(error) });
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [data.plugins]);

  useEffect(() => {
    if (!feedback) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setFeedback(null), 4000);
  }, [feedback]);

  if (!feedback) return null;
  return <div className={`plugin-action-toast${feedback.error ? " has-error" : ""}`} role="status" aria-live="polite">
    {feedback.error
      ? `${feedback.actionTitle}: ${feedback.error}`
      : `${feedback.actionTitle}: requested`}
  </div>;
}
