/**
 * Shared utility functions for the AlphaZede Sports MCP Server.
 */

import { writeInternalLog } from "./output-sink-registry.js";
import { KNOWN_TIERS } from "./types.js";

const LOG_LEVEL = process.env.AZS_LOG_LEVEL ?? "info";

/**
 * Return today's date as YYYY-MM-DD in ET timezone.
 */
export function todayString(): string {
  const now = new Date();
  const tz = process.env.AZS_TIMEZONE ?? "America/New_York";
  // Use Intl to get date parts in the target timezone
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year =
    parts.find((p) => p.type === "year")?.value ?? String(now.getFullYear());
  const month =
    parts.find((p) => p.type === "month")?.value ??
    String(now.getMonth() + 1).padStart(2, "0");
  const day =
    parts.find((p) => p.type === "day")?.value ??
    String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Sanitize an AZS tier value. Returns the tier if it's a known value,
 * otherwise returns "--".
 */
export function safeTier(raw: string | null | undefined): string {
  if (!raw) return "--";
  const upper = raw.toUpperCase();
  if ((KNOWN_TIERS as readonly string[]).includes(upper)) return upper;
  return "--";
}

export function log(level: string, message: string): void {
  const levels: Record<string, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
  };
  const threshold = levels[LOG_LEVEL] ?? 2;
  const msgLevel = levels[level] ?? 2;
  if (msgLevel <= threshold) {
    // truncate log messages to max 200 chars to avoid leaking verbose errors
    const truncated =
      message.length > 200 ? `${message.slice(0, 200)}...` : message;
    writeInternalLog(`[${level.toUpperCase()}] ${truncated}\n`);
  }
}
