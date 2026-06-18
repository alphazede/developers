/**
 * Response formatting utilities for the AlphaZede Sports MCP Server.
 *
 * Formats API responses into structured text for machine-readable clients.
 * SECURITY: Never includes raw internal scoring values; only public grades and directional signals are emitted.
 */

import type {
  DriftPoint,
  Game,
  GameBoardResponse,
  MovementEntry,
  Prop,
  SgpEvaluateResponse,
} from "./types.js";
import { safeTier } from "./util.js";

// ---------------------------------------------------------------------------
// Velocity-class helpers — inlined from public MCP type definitions to avoid a runtime dep
// (public MCP type definitions is public source only; value imports would break consumer installs)
// ---------------------------------------------------------------------------

const AZS_DELTA_VELOCITY_CLASS_LABELS: Record<string, string> = {
  public_tilt: "PUBLIC_TILT",
  market_adjustment: "MARKET_ADJUSTMENT",
  sharp_move: "SHARP_MOVE",
  steam_move: "STEAM_MOVE",
};

const SHARP_VELOCITY_CLASSES = new Set([
  "SHARP",
  "SPIKE",
  "SUSPICIOUS",
  "SHARP_MOVE",
  "STEAM_MOVE",
]);

// public formatter: strict-output normalizer. Mirrors the strict path in
// `public MCP type definitions/velocity-class.ts` (devDependency-only — value imports would
// break consumer installs, so the canonical taxonomy is inlined).
// Unknown values fall through to the raw uppercase form for display
// visibility; never silently coerced to "NORMAL".
function normalizeApiVelocityClass(value: string): string {
  const normalizedKey = value
    .trim()
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  const deltaLabel = AZS_DELTA_VELOCITY_CLASS_LABELS[normalizedKey];
  return deltaLabel ?? normalizedKey.toUpperCase();
}

function isSharpVelocityClass(value: string): boolean {
  return SHARP_VELOCITY_CLASSES.has(normalizeApiVelocityClass(value));
}

const ATTRIBUTION = "Data from AlphaZede Sports";

export function heading(text: string): string {
  return `${text}:`;
}

export function bullet(items: readonly string[]): string {
  return items.map((item) => `  ${item}`).join("\n");
}

export function separator(): string {
  return "\n";
}

export function attribution(): string {
  return ATTRIBUTION;
}

export function formatVelocityClass(value: string | null | undefined): string {
  return normalizeApiVelocityClass(value ?? "NORMAL");
}

// ---------------------------------------------------------------------------
// Grade helpers
// ---------------------------------------------------------------------------

/**
 * Return the display grade for a prop. Uses only the public grade field.
 * Returns "--" if no grade is available.
 */
export function propGrade(prop: Prop): string {
  if (prop.grade) return String(prop.grade);
  return "--";
}

/**
 * Numeric sort weight for grades (lower = better).
 */
export function gradeWeight(grade: string): number {
  const order: Record<string, number> = {
    "A+": 0,
    A: 1,
    "B+": 2,
    B: 3,
    C: 4,
    D: 5,
  };
  return order[grade] ?? 6;
}

// ---------------------------------------------------------------------------
// Games list
// ---------------------------------------------------------------------------

export function formatGamesList(
  games: Game[],
  sport: string,
  date: string,
): string {
  if (games.length === 0) {
    return `No ${sport.toUpperCase()} games found for ${date}.\n\n${attribution()}`;
  }

  const lines: string[] = [
    `${sport.toUpperCase()} Games for ${date}`,
    "=".repeat(40),
    "",
  ];

  for (const game of games) {
    const time = formatTime(game.start_time);
    const status =
      game.status === "live"
        ? " [LIVE]"
        : game.status === "final"
          ? " [FINAL]"
          : "";
    lines.push(`${game.away_team} @ ${game.home_team} -- ${time}${status}`);
    lines.push(bullet([`Game ID: ${game.game_id}`]));
    lines.push(bullet([`Props available: ${game.prop_count}`]));
    if (game.has_sharp_moves) {
      lines.push(bullet(["Sharp activity detected"]));
    }
    lines.push("");
  }

  lines.push(attribution());
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Gameboard
// ---------------------------------------------------------------------------

export function formatGameboard(
  board: GameBoardResponse,
  sport: string,
): string {
  const ctx = board.game_context;
  const lines: string[] = [
    `${sport.toUpperCase()} Gameboard: ${ctx.away_team} @ ${ctx.home_team}`,
    "=".repeat(50),
    `Status: ${ctx.status} | Start: ${formatTime(ctx.start_time)}`,
    `Total props: ${ctx.prop_count}`,
    "",
  ];

  if (board.props.length === 0) {
    lines.push("No props currently available for this game.");
  } else {
    // Sort by grade quality descending
    const sorted = [...board.props].sort(
      (a, b) => gradeWeight(propGrade(a)) - gradeWeight(propGrade(b)),
    );

    for (const prop of sorted) {
      const grade = propGrade(prop);
      const tier = safeTier(prop.azs_tier);
      const sharp = isSharpVelocityClass(prop.velocity_class)
        ? " | Sharp movement detected"
        : "";
      lines.push(
        `- ${prop.player} | ${prop.stat} | ${prop.line} | Grade: ${grade} | Tier: ${tier}${sharp}`,
      );
    }
  }

  lines.push("");
  lines.push(attribution());
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Props list
// ---------------------------------------------------------------------------

export function formatProps(
  props: Prop[],
  sport: string,
  gameId: string,
): string {
  if (props.length === 0) {
    return `No matching props found for ${sport.toUpperCase()} game ${gameId}.\n\n${attribution()}`;
  }

  const lines: string[] = [
    `Props for ${sport.toUpperCase()} game ${gameId}`,
    "=".repeat(50),
    "",
  ];

  for (const prop of props) {
    const grade = propGrade(prop);
    lines.push(`${prop.player} -- ${prop.stat} ${prop.line}`);
    lines.push(
      bullet([
        `Grade: ${grade} | Velocity: ${formatVelocityClass(prop.velocity_class)}`,
      ]),
    );
    if (prop.best_book) {
      lines.push(
        bullet([
          `Best line: ${prop.best_book} @ ${prop.best_odds ?? prop.odds}`,
        ]),
      );
    }
    lines.push(bullet([`Prop ID: ${prop.prop_id}`]));
    lines.push("");
  }

  lines.push(attribution());
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Movement history
// ---------------------------------------------------------------------------

export function formatMovement(
  history: MovementEntry[],
  propId: string,
): string {
  if (history.length === 0) {
    return `No movement history found for prop ${propId}.\n\n${attribution()}`;
  }

  const lines: string[] = [
    `Line Movement History: ${propId}`,
    "=".repeat(50),
    "",
  ];

  for (const entry of history) {
    lines.push(
      `- ${formatTime(entry.timestamp)} | Line: ${entry.line} | Source: ${entry.source} | Velocity: ${formatVelocityClass(entry.velocity_class)}`,
    );
  }

  lines.push("");
  lines.push(attribution());
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// SGP evaluation
// ---------------------------------------------------------------------------

export function formatSgpEvaluation(response: SgpEvaluateResponse): string {
  const evLabel =
    response.ev_percentage > 0
      ? "Positive"
      : response.ev_percentage < 0
        ? "Negative"
        : "Neutral";
  const lines: string[] = [
    "Parlay Correlation Analysis",
    "=".repeat(40),
    "",
    `Recommendation: ${response.recommendation}`,
    `Correlation: ${(response.correlation_coefficient * 100).toFixed(1)}%`,
    `Historical joint hit rate: ${(response.historical_joint_hit_rate * 100).toFixed(1)}%`,
    `Sample size: ${response.shared_games} games`,
    `EV assessment: ${evLabel}`,
    `Archetype: ${response.archetype}`,
    "",
    attribution(),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Edge explanation
// ---------------------------------------------------------------------------

export function formatEdgeExplanation(
  prop: Prop,
  movement: MovementEntry[],
  drift: DriftPoint[],
  sport: string,
): string {
  const grade = propGrade(prop);
  const lines: string[] = [
    `Edge Analysis: ${prop.player} -- ${prop.stat} ${prop.line}`,
    "=".repeat(50),
    "",
    `Sport: ${sport.toUpperCase()}`,
    `Grade: ${grade}`,
    `Velocity: ${formatVelocityClass(prop.velocity_class)}`,
  ];

  if (prop.azs_tier) {
    lines.push(`Tier: ${safeTier(prop.azs_tier)}`);
  }
  if (prop.best_book) {
    lines.push(`Best line: ${prop.best_book} @ ${prop.best_odds ?? prop.odds}`);
  }

  // Line movement summary
  if (movement.length > 0) {
    lines.push("");
    lines.push(heading("Line Movement"));
    const first = movement[0];
    const last = movement[movement.length - 1];
    const delta = last.line - first.line;
    const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
    lines.push(
      bullet([
        `Moved from ${first.line} to ${last.line} (${direction}, ${movement.length} updates)`,
      ]),
    );

    const sharpMoves = movement.filter((m) =>
      isSharpVelocityClass(m.velocity_class),
    );
    if (sharpMoves.length > 0) {
      lines.push(bullet([`Sharp/spike moves detected: ${sharpMoves.length}`]));
    }
  }

  // Drift signals
  if (drift.length > 0) {
    lines.push("");
    lines.push(heading("Drift Signals"));
    const recent = drift.slice(-3);
    for (const point of recent) {
      const pointGrade = point.grade ?? null;
      const gradeStr = pointGrade ? ` (Grade: ${pointGrade})` : "";
      lines.push(
        bullet([
          `${formatTime(point.timestamp)}: Line ${point.line}${gradeStr} -- ${point.event_description}`,
        ]),
      );
    }
  }

  // Book comparison
  if (prop.lines_by_book && Object.keys(prop.lines_by_book).length > 1) {
    lines.push("");
    lines.push(heading("Book Comparison"));
    for (const [book, line] of Object.entries(prop.lines_by_book)) {
      lines.push(bullet([`${book}: ${line}`]));
    }
  }

  lines.push("");
  lines.push(attribution());
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Daily picks
// ---------------------------------------------------------------------------

export interface RankedPick {
  sport: string;
  game_id: string;
  home_team: string;
  away_team: string;
  start_time: string;
  prop: Prop;
}

export function formatDailyPicks(picks: RankedPick[], date: string): string {
  if (picks.length === 0) {
    return `No top-rated props found for ${date}.\n\n${attribution()}`;
  }

  const lines: string[] = [`Top Picks for ${date}`, "=".repeat(50), ""];

  for (let i = 0; i < picks.length; i++) {
    const pick = picks[i];
    const grade = propGrade(pick.prop);
    lines.push(
      `${i + 1}. ${pick.prop.player} -- ${pick.prop.stat} ${pick.prop.line}`,
    );
    lines.push(`   Grade: ${grade} | Sport: ${pick.sport.toUpperCase()}`);
    lines.push(
      `   Game: ${pick.away_team} @ ${pick.home_team} (${formatTime(pick.start_time)})`,
    );
    const velocityClass = formatVelocityClass(pick.prop.velocity_class);
    if (velocityClass !== "NORMAL") {
      lines.push(`   Velocity: ${velocityClass}`);
    }
    if (pick.prop.best_book) {
      lines.push(
        `   Best line: ${pick.prop.best_book} @ ${pick.prop.best_odds ?? pick.prop.odds}`,
      );
    }
    lines.push("");
  }

  lines.push(attribution());
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    const tz = process.env.AZS_TIMEZONE ?? "America/New_York";
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz,
      timeZoneName: "short",
    });
  } catch {
    return isoString;
  }
}
