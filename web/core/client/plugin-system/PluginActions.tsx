// Plugin action UI — ported from the vendored app: confirmed actions type
// their string (byte-identical), instant actions (per the plugin-actions
// PRD) submit with one click, and every surface shares one POST path.

import React, { useState } from "react";
import type { ActionDescriptor } from "./contract.ts";
import { postPluginAction } from "./actionClient.ts";

interface PluginActionsProps {
  pluginId: string;
  sessionId: string | null;
  actions?: readonly ActionDescriptor[];
}

export function PluginActions({ pluginId, sessionId, actions }: PluginActionsProps) {
  const [confirmInputs, setConfirmInputs] = useState<Record<string, string>>({});
  const [statusMap, setStatusMap] = useState<
    Record<string, { type: "success" | "error"; message: string; requestId?: string }>
  >({});
  const [loadingAction, setLoadingAction] = useState<string | null>(null);

  if (!actions || actions.length === 0) {
    return null;
  }

  const handleInputChange = (actionId: string, value: string) => {
    setConfirmInputs((prev) => ({ ...prev, [actionId]: value }));
  };

  const handleActionSubmit = async (action: ActionDescriptor) => {
    const confirmVal = confirmInputs[action.id] ?? "";

    if (action.confirm !== undefined && confirmVal !== action.confirm) {
      setStatusMap((prev) => ({
        ...prev,
        [action.id]: {
          type: "error",
          message: `Confirmation string must match "${action.confirm}"`,
        },
      }));
      return;
    }

    if (!sessionId) {
      setStatusMap((prev) => ({
        ...prev,
        [action.id]: {
          type: "error",
          message: "No active session available",
        },
      }));
      return;
    }

    setLoadingAction(action.id);
    setStatusMap((prev) => {
      const next = { ...prev };
      delete next[action.id];
      return next;
    });

    try {
      const { data } = await postPluginAction(sessionId, pluginId, action);

      if (!data.ok) {
        setStatusMap((prev) => ({
          ...prev,
          [action.id]: {
            type: "error",
            message: data.error || "Action failed",
          },
        }));
      } else {
        setStatusMap((prev) => ({
          ...prev,
          [action.id]: {
            type: "success",
            message: `Action accepted (request ID: ${data.requestId})`,
            requestId: data.requestId,
          },
        }));
        // Reset confirmation input on success.
        setConfirmInputs((prev) => ({ ...prev, [action.id]: "" }));
      }
    } catch (err) {
      setStatusMap((prev) => ({
        ...prev,
        [action.id]: {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        },
      }));
    } finally {
      setLoadingAction(null);
    }
  };

  return (
    <div className="plugin-actions-section" aria-label="Plugin actions">
      <h2 className="plugin-actions-title">Actions</h2>
      <div className="plugin-actions-grid">
        {actions.map((action) => {
          const typedConfirm = confirmInputs[action.id] ?? "";
          const isConfirmed = action.confirm === undefined || typedConfirm === action.confirm;
          const isLoading = loadingAction === action.id;
          const status = statusMap[action.id];

          return (
            <div key={action.id} className="plugin-action-card" data-action-id={action.id}>
              <div className="plugin-action-row">
                {action.confirm === undefined ? (
                  // An instant action: one click, no typed string.
                  <button
                    type="button"
                    className="plugin-action-button plugin-action-instant"
                    onClick={() => {
                      void handleActionSubmit(action);
                    }}
                    disabled={isLoading}
                    data-testid={`action-button-${action.id}`}
                  >
                    {isLoading ? "Submitting..." : action.title}
                    {action.keybinding ? <kbd className="plugin-action-keybinding">{action.keybinding}</kbd> : null}
                  </button>
                ) : (
                  <>
                    <input
                      type="text"
                      className="plugin-action-input"
                      placeholder={`Type "${action.confirm}" to confirm`}
                      value={typedConfirm}
                      onChange={(e) => handleInputChange(action.id, e.target.value)}
                      disabled={isLoading}
                      data-testid={`action-input-${action.id}`}
                      aria-label={`Confirm ${action.title}`}
                    />
                    <button
                      type="button"
                      className="plugin-action-button"
                      onClick={() => {
                        void handleActionSubmit(action);
                      }}
                      disabled={!isConfirmed || isLoading}
                      data-testid={`action-button-${action.id}`}
                    >
                      {isLoading ? "Submitting..." : action.title}
                    </button>
                  </>
                )}
              </div>
              {status ? (
                <div
                  className={`plugin-action-feedback ${status.type === "success" ? "feedback-success" : "feedback-error"}`}
                  data-testid={`action-status-${action.id}`}
                  role="status"
                >
                  {status.message}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
