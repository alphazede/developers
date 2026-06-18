/**
 * Tool: get_ml_projection
 *
 * Get a machine learning projection for a specific player's stat line.
 */

import { z } from "zod";
import { attribution, bullet, heading } from "../format.js";
import { defineSimpleTool } from "../tool.js";
import type { Sport } from "../types.js";
import { SUPPORTED_SPORTS_DESCRIPTION, sportEnum } from "../types.js";

const getMlProjectionParamsShape = {
  sport: sportEnum.describe(`Sport (${SUPPORTED_SPORTS_DESCRIPTION}).`),
  player: z
    .string()
    .min(1)
    .max(200)
    .describe("Player name (e.g. 'Shohei Ohtani')."),
  stat: z
    .string()
    .min(1)
    .max(50)
    .describe("Stat type (e.g. 'strikeouts', 'points', 'assists')."),
};

const GET_ML_PROJECTION_NAME_VALUE = "get_ml_projection";
const GET_ML_PROJECTION_DESCRIPTION_VALUE =
  "Get an analytics-derived projection for a specific player's stat line. " +
  "Returns the projected value based on recent performance, matchup factors, " +
  `and contextual data. Supported sports: ${SUPPORTED_SPORTS_DESCRIPTION}.`;

export const getMlProjectionTool = defineSimpleTool({
  name: GET_ML_PROJECTION_NAME_VALUE,
  description: GET_ML_PROJECTION_DESCRIPTION_VALUE,
  params: getMlProjectionParamsShape,
  fetch: (client, input) =>
    client.getMlProjection(input.sport as Sport, input.player, input.stat),
  format: (data, input) => {
    if (data.projected_value == null && !data.model_date) {
      return `No ML projection available for ${input.player} ${input.stat} (${input.sport.toUpperCase()}).`;
    }
    const lines = [
      heading(
        `Projection for ${data.player ?? input.player} — ${data.stat ?? input.stat} (${data.sport ?? input.sport})`,
      ),
      bullet([
        `Projected value: ${data.projected_value ?? "N/A"}`,
        `Model date: ${data.model_date ?? "N/A"}`,
      ]),
      "",
      attribution(),
    ];
    return lines.join("\n");
  },
});
