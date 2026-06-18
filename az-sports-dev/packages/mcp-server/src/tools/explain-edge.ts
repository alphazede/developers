/**
 * Tool: explain_edge
 *
 * Get a detailed analysis explanation for a specific prop, combining
 * gameboard data, movement history, and drift signals.
 *
 * SECURITY: This tool MUST NOT expose raw scores, internal model names,
 * or internal methodology details. Returns grades and directional signals only.
 */

import { z } from "zod";
import { attribution, formatEdgeExplanation } from "../format.js";
import { defineTool } from "../tool.js";
import {
  type Prop,
  SUPPORTED_SPORTS_DESCRIPTION,
  sportEnum,
} from "../types.js";

const explainEdgeParamsShape = {
  sport: sportEnum.describe(`Sport (${SUPPORTED_SPORTS_DESCRIPTION})`),
  game_id: z.string().min(1).max(256).describe("Game identifier"),
  prop_id: z.string().min(1).max(256).describe("Prop identifier"),
};

const EXPLAIN_EDGE_NAME_VALUE = "explain_edge";
const EXPLAIN_EDGE_DESCRIPTION_VALUE =
  "Get a detailed edge analysis for a specific prop. Combines current market data, " +
  "line movement trajectory, and drift signals into a structured analysis brief. " +
  `Returns grades and directional signals for the requested prop. Supported sports: ${SUPPORTED_SPORTS_DESCRIPTION}.`;

export const explainEdgeTool = defineTool({
  name: EXPLAIN_EDGE_NAME_VALUE,
  description: EXPLAIN_EDGE_DESCRIPTION_VALUE,
  params: explainEdgeParamsShape,
  handler: async (ctx, input) => {
    const client = ctx.client;
    // Fetch gameboard to find the prop
    const board = await client.getGameboard(input.sport, input.game_id);
    const prop = board.props.find((p: Prop) => p.prop_id === input.prop_id);

    if (!prop) {
      return `No prop found with ID ${input.prop_id} in game ${input.game_id}.\n\n${attribution()}`;
    }

    // Fetch movement history and drift in parallel
    const [movementResult, driftResult] = await Promise.allSettled([
      client.getMovementHistory(input.sport, input.game_id, input.prop_id),
      client.getDrift(input.sport, input.prop_id),
    ]);

    const movement =
      movementResult.status === "fulfilled" ? movementResult.value.history : [];

    const drift =
      driftResult.status === "fulfilled" ? driftResult.value.drift_history : [];

    return formatEdgeExplanation(prop, movement, drift, input.sport);
  },
});
