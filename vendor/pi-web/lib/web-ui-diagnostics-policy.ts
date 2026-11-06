/** The diagnostics route remains inside the ordinary pi-web auth perimeter. */
export function uiDiagnosticsEnabled(env: { NODE_ENV?: string; PI_WEB_UI_DIAGNOSTICS?: string }): boolean {
  return env.NODE_ENV !== "production" || env.PI_WEB_UI_DIAGNOSTICS === "1";
}
