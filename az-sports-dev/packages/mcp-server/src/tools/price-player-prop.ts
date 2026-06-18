/**
 * Tool: price_player_prop
 *
 * Look up a specific player prop with current lines and analysis.
 * Optionally includes line movement history.
 */

import { z } from "zod";
import { formatMovement, formatProps } from "../format.js";
import { defineTool } from "../tool.js";
import {
  type Prop,
  SUPPORTED_SPORTS_DESCRIPTION,
  sportEnum,
} from "../types.js";

const pricePlayerPropParamsShape = {
  sport: sportEnum.describe(`Sport (${SUPPORTED_SPORTS_DESCRIPTION})`),
  game_id: z.string().min(1).max(256).describe("Game identifier"),
  player_name: z
    .string()
    .max(200)
    .optional()
    .describe("Filter props by player name (case-insensitive partial match)"),
  prop_type: z
    .string()
    .max(200)
    .optional()
    .describe("Filter by prop type (e.g. points, rebounds, passing_yards)"),
  include_movement: z
    .boolean()
    .optional()
    .describe(
      "If true, include line movement history for matching props. Default: false.",
    ),
};

const PRICE_PLAYER_PROP_NAME_VALUE = "price_player_prop";
const PRICE_PLAYER_PROP_DESCRIPTION_VALUE =
  "Look up player props for a specific game with current lines, grades, and book comparison. " +
  "Filter by player name or prop type. Optionally include line movement history to see how " +
  `the line has changed over time. Supported sports: ${SUPPORTED_SPORTS_DESCRIPTION}.`;

export const pricePlayerPropTool = defineTool({
  name: PRICE_PLAYER_PROP_NAME_VALUE,
  description: PRICE_PLAYER_PROP_DESCRIPTION_VALUE,
  params: pricePlayerPropParamsShape,
  handler: async (ctx, input) => {
    const client = ctx.client;
    const response = await client.getGameProps(input.sport, input.game_id);
    let props = response.props;

    // Filter by player name (case-insensitive partial match)
    if (input.player_name) {
      const query = input.player_name.toLowerCase();
      props = props.filter((p: Prop) => p.player.toLowerCase().includes(query));
    }

    // Filter by prop type
    if (input.prop_type) {
      const query = input.prop_type.toLowerCase();
      props = props.filter((p: Prop) => p.stat.toLowerCase().includes(query));
    }

    const propsText = formatProps(props, input.sport, input.game_id);

    // Optionally fetch movement history for matching props
    if (input.include_movement && props.length > 0) {
      const movementSections: string[] = [propsText, ""];

      // Limit to first 5 props to avoid excessive API calls
      const propsToFetch = props.slice(0, 5);
      const results = await Promise.allSettled(
        propsToFetch.map((prop) =>
          client
            .getMovementHistory(input.sport, input.game_id, prop.prop_id)
            .then((m) => ({ propId: prop.prop_id, history: m.history })),
        ),
      );

      for (const result of results) {
        if (result.status === "fulfilled" && result.value.history.length > 0) {
          movementSections.push(
            formatMovement(result.value.history, result.value.propId),
          );
          movementSections.push("");
        }
      }

      return movementSections.join("\n");
    }

    return propsText;
  },
});
