/**
 * Tool: get_forecasts
 *
 * Get game forecasts for a sport — analytics-derived predictions
 * for upcoming games.
 */

import { attribution, bullet, heading, separator } from "../format.js";
import { defineSimpleTool } from "../tool.js";
import type { Sport } from "../types.js";
import { SUPPORTED_SPORTS_DESCRIPTION, sportEnum } from "../types.js";

const getForecastsParamsShape = {
  sport: sportEnum.describe(
    `Sport to get forecasts for (${SUPPORTED_SPORTS_DESCRIPTION}).`,
  ),
};

const GET_FORECASTS_NAME_VALUE = "get_forecasts";
const GET_FORECASTS_DESCRIPTION_VALUE =
  "Get game forecasts for a sport — analytics-derived predictions " +
  `for upcoming games. Supported sports: ${SUPPORTED_SPORTS_DESCRIPTION}. ` +
  "Useful for pre-game research and identifying value against posted lines.";

export const getForecastsTool = defineSimpleTool({
  name: GET_FORECASTS_NAME_VALUE,
  description: GET_FORECASTS_DESCRIPTION_VALUE,
  params: getForecastsParamsShape,
  fetch: (client, input) => client.getForecasts(input.sport as Sport),
  format: (data, input) => {
    const forecasts = data.forecasts ?? [];
    if (!forecasts.length) {
      return `No forecasts currently available for ${input.sport.toUpperCase()}. Forecasts are generated as games approach.`;
    }
    const lines = [
      heading(
        `Forecasts for ${input.sport.toUpperCase()} — ${data.date ?? "today"} (${forecasts.length} game${forecasts.length === 1 ? "" : "s"})`,
      ) + separator(),
    ];
    for (const f of forecasts.slice(0, 15)) {
      const forecast = f.forecast ?? {};
      const summary =
        typeof forecast === "string"
          ? forecast
          : JSON.stringify(forecast).slice(0, 200);
      lines.push(
        bullet([
          `${f.game_id} (${f.league ?? input.sport.toUpperCase()}) — ${summary}`,
        ]),
      );
    }
    if (forecasts.length > 15)
      lines.push(bullet([`... and ${forecasts.length - 15} more`]));
    lines.push(separator() + attribution());
    return lines.join("\n");
  },
});
