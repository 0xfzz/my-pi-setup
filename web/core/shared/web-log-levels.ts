/** Shared logger vocabulary; browser-safe and free of Node APIs. */
export const WEB_LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
export type WebLogLevel = (typeof WEB_LOG_LEVELS)[number];
export const DEFAULT_WEB_LOG_LEVEL: WebLogLevel = "info";

export function parseWebLogLevel(value: string | undefined): WebLogLevel {
  const normalized = value?.trim().toLowerCase();
  return WEB_LOG_LEVELS.find((level) => level === normalized) ?? DEFAULT_WEB_LOG_LEVEL;
}
