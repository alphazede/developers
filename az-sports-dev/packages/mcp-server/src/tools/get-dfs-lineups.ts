/**
 * Tool: get_dfs_lineups
 *
 * Get optimized DFS lineups for a sport and platform.
 */

import { z } from "zod";
import * as format from "../format.js";
import { defineSimpleTool } from "../tool.js";
import { SUPPORTED_SPORTS_DESCRIPTION, sportEnum } from "../types.js";

const getDfsLineupsParamsShape = {
  sport: sportEnum.describe(`Sport (${SUPPORTED_SPORTS_DESCRIPTION}).`),
  platform: z
    .enum(["dk", "fd", "yahoo"])
    .describe("DFS platform: dk (DraftKings), fd (FanDuel), or yahoo."),
};

const GET_DFS_LINEUPS_NAME_VALUE = "get_dfs_lineups";
const GET_DFS_LINEUPS_DESCRIPTION_VALUE =
  "Get optimized DFS lineups for a sport and platform. " +
  "Returns ranked lineups with player selections, salaries, positions, " +
  `and projected points. Supported sports: ${SUPPORTED_SPORTS_DESCRIPTION}. ` +
  "Platforms: dk (DraftKings), fd (FanDuel), yahoo.";

export const getDfsLineupsTool = defineSimpleTool({
  name: GET_DFS_LINEUPS_NAME_VALUE,
  description: GET_DFS_LINEUPS_DESCRIPTION_VALUE,
  params: getDfsLineupsParamsShape,
  fetch: (client, input) => client.getDfsLineups(input.sport, input.platform),
  format: (data, input) => {
    const lineups = data.lineups ?? [];
    if (!lineups.length) {
      return `No DFS lineups available for ${input.sport.toUpperCase()} on ${input.platform}. Lineups are generated daily for active slates.`;
    }
    const lines = [
      format.heading(
        `DFS Lineups — ${input.sport.toUpperCase()} on ${input.platform} (${lineups.length} lineup${lineups.length === 1 ? "" : "s"})`,
      ) + format.separator(),
    ];
    for (const lineup of lineups.slice(0, 5)) {
      lines.push(
        format.bullet([
          `Lineup #${lineup.rank ?? "?"} | Salary: $${lineup.total_salary?.toLocaleString() ?? "?"} | Projected: ${lineup.projected_points?.toFixed(1) ?? "?"} pts`,
        ]),
      );
      for (const p of lineup.players ?? []) {
        lines.push(
          `    ${p.position} ${p.player_name} (${p.team}) — $${p.salary?.toLocaleString() ?? "?"} / ${p.projected_points?.toFixed(1) ?? "?"} pts`,
        );
      }
      lines.push("");
    }
    if (lineups.length > 5)
      lines.push(format.bullet([`... and ${lineups.length - 5} more lineups`]));
    lines.push(format.attribution());
    return lines.join("\n");
  },
});
