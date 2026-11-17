/** Server-side policy for pi-web logging. Pure configuration only; no streams or clock. */
import { join } from "node:path";

export const WEB_LOG_FILE_NAME = "pi-web.log";

export function isWebLogFileDisabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "off" || normalized === "none" || normalized === "0" || normalized === "false";
}

/** Default to a human-readable file; JSON lines remain available for tooling. */
export function webLogFileFormat(value: string | undefined): "pretty" | "json" {
  return value?.trim().toLowerCase() === "json" ? "json" : "pretty";
}

export function webLogFilePath(agentDir: string, override?: string): string {
  const explicit = override?.trim();
  return explicit === undefined || explicit === "" ? join(agentDir, "logs", WEB_LOG_FILE_NAME) : explicit;
}

/** A forced TTY pretty stream is useful when capturing output from a supervisor. */
export function shouldPrettyLog(isTTY: boolean, override: string | undefined): boolean {
  const value = override?.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "on") return true;
  if (value === "0" || value === "false" || value === "off") return false;
  return isTTY;
}
