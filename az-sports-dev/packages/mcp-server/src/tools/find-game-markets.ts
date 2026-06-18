/**
 * Tool: find_game_markets
 *
 * Find games and their prop markets for a given sport and date.
 * Entry-point tool -- users typically start here.
 */

import { z } from "zod";
import { formatGameboard, formatGamesList } from "../format.js";
import { defineTool } from "../tool.js";
import { SUPPORTED_SPORTS_DESCRIPTION, sportEnum } from "../types.js";
import { todayString } from "../util.js";

const findGameMarketsParamsShape = {
  sport: sportEnum.describe(
    `Sport to search (${SUPPORTED_SPORTS_DESCRIPTION})`,
  ),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
    .optional()
    .describe("Date in YYYY-MM-DD format. Defaults to today if not provided."),
  game_id: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "If provided, fetch the full gameboard for this specific game instead of listing all games.",
    ),
};

const FIND_GAME_MARKETS_NAME_VALUE = "find_game_markets";
const FIND_GAME_MARKETS_DESCRIPTION_VALUE =
  "Find games and their prop markets for a given sport and date. " +
  "Returns a list of scheduled, live, or completed games with team matchups and available market counts. " +
  `Optionally fetch the full gameboard for a specific game to see all prop markets and analysis grades. Supported sports: ${SUPPORTED_SPORTS_DESCRIPTION}.`;

export const findGameMarketsTool = defineTool({
  name: FIND_GAME_MARKETS_NAME_VALUE,
  description: FIND_GAME_MARKETS_DESCRIPTION_VALUE,
  params: findGameMarketsParamsShape,
  handler: async (ctx, input) => {
    const client = ctx.client;
    const date = input.date ?? todayString();

    // If game_id is provided, fetch the full gameboard
    if (input.game_id) {
      const board = await client.getGameboard(input.sport, input.game_id);
      return formatGameboard(board, input.sport);
    }

    // Otherwise, list all games for the sport and date
    const response = await client.listGames(input.sport, date);
    return formatGamesList(response.games, input.sport, date);
  },
});
