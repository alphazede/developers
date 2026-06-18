/**
 * Tool: analyze_parlay
 *
 * Evaluate a same-game parlay for correlation risk and EV assessment.
 * Premium tier only (Pro or Enterprise).
 */

import { z } from "zod";
import { formatSgpEvaluation } from "../format.js";
import { defineTool } from "../tool.js";
import { SUPPORTED_SPORTS_DESCRIPTION, sportEnum } from "../types.js";

const analyzeParlayParamsShape = {
  sport: sportEnum.describe(
    `Sport for this same-game parlay (${SUPPORTED_SPORTS_DESCRIPTION})`,
  ),
  game_id: z
    .string()
    .min(1)
    .max(256)
    .describe("Game identifier for this same-game parlay"),
  sportsbook_parlay_odds: z
    .number()
    .optional()
    .describe("The sportsbook's parlay odds (default: 1.0)"),
  legs: z
    .array(
      z.object({
        prop_id: z.string().min(1).max(256).describe("The prop identifier"),
        side: z.enum(["over", "under"]).describe("Direction: over or under"),
        player: z.string().min(1).max(200).describe("Player name"),
        stat: z
          .string()
          .min(1)
          .max(200)
          .describe("Stat type (e.g. points, rebounds)"),
        line: z.number().describe("The prop line"),
        game_id: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe(
            "Game identifier for this leg (optional, defaults to top-level)",
          ),
      }),
    )
    .min(2)
    .max(20)
    .describe("Array of parlay legs (minimum 2, maximum 20)"),
};

const ANALYZE_PARLAY_NAME_VALUE = "analyze_parlay";
const ANALYZE_PARLAY_DESCRIPTION_VALUE =
  "Evaluate a same-game parlay for correlation risk and EV assessment. " +
  "Analyzes how the legs of a parlay are correlated based on historical data, " +
  `and provides a recommendation. Supported sports: ${SUPPORTED_SPORTS_DESCRIPTION}. ` +
  "Requires a Pro or Enterprise subscription.";

export const analyzeParlayTool = defineTool({
  name: ANALYZE_PARLAY_NAME_VALUE,
  description: ANALYZE_PARLAY_DESCRIPTION_VALUE,
  params: analyzeParlayParamsShape,
  handler: async (ctx, input) => {
    const client = ctx.client;
    // Use top-level sport and game_id (SGP is same-game)
    const sport = input.sport;
    const gameId = input.game_id;
    const parlayOdds = input.sportsbook_parlay_odds ?? 1.0;

    // Build proper SGP legs matching POST /api/v1/sgp/evaluate schema
    const sgpLegs = input.legs.map((leg) => ({
      player: leg.player,
      stat: leg.stat,
      line: leg.line,
      direction: leg.side,
    }));

    // Let errors propagate to safeHandle -- no try/catch here.
    // The 403 case is handled by safeHandle via the standard error mapping.
    const response = await client.evaluateSgp(
      sport,
      gameId,
      sgpLegs,
      parlayOdds,
    );

    // Format only the public fields used by the renderer.
    const publicResponse = { ...response };

    // formatSgpEvaluation already appends attribution() internally.
    return formatSgpEvaluation(publicResponse);
  },
});
