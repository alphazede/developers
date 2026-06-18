/**
 * Tool: get_futures
 *
 * Get futures market data for a sport — early lines, line movement, and drift signals.
 */

import * as format from "../format.js";
import { defineSimpleTool } from "../tool.js";
import type { FutureGame, Sport } from "../types.js";
import { SUPPORTED_SPORTS_DESCRIPTION, sportEnum } from "../types.js";

const getFuturesParamsShape = {
  sport: sportEnum.describe(
    `Sport to get futures for (${SUPPORTED_SPORTS_DESCRIPTION}).`,
  ),
};

const GET_FUTURES_NAME_VALUE = "get_futures";
const GET_FUTURES_DESCRIPTION_VALUE =
  "Get futures markets for a sport — early lines, line movement tracking, and drift signals " +
  `for upcoming games. Supported sports: ${SUPPORTED_SPORTS_DESCRIPTION}.`;

export const getFuturesTool = defineSimpleTool({
  name: GET_FUTURES_NAME_VALUE,
  description: GET_FUTURES_DESCRIPTION_VALUE,
  params: getFuturesParamsShape,
  fetch: (client, input) => client.getFutures(input.sport as Sport),
  format: (data, input) => {
    const games: FutureGame[] = data.futures ?? [];
    if (!games.length) {
      return `No futures markets currently available for ${input.sport.toUpperCase()}.`;
    }
    const lines = [
      format.heading(
        `Futures markets for ${input.sport.toUpperCase()} (${games.length} games)`,
      ) + format.separator(),
    ];
    for (const g of games.slice(0, 15)) {
      lines.push(
        format.bullet([`${g.home_team} vs ${g.away_team} (${g.game_date})`]),
      );
      for (const el of (g.early_lines ?? []).slice(0, 5)) {
        const movement =
          el.line_movement !== 0
            ? ` | moved ${el.line_movement > 0 ? "+" : ""}${el.line_movement.toFixed(1)}`
            : "";
        lines.push(
          `    ${el.player} ${el.stat}: ${el.line}${movement} [${format.formatVelocityClass(el.velocity_class)}]`,
        );
      }
    }
    if (games.length > 15)
      lines.push(format.bullet([`... and ${games.length - 15} more games`]));
    lines.push(format.separator() + format.attribution());
    return lines.join("\n");
  },
});
