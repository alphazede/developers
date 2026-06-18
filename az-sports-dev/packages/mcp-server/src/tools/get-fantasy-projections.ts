/**
 * Tool: get_fantasy_projections
 *
 * Get fantasy sports projections — player rankings, projected points,
 * waiver wire recommendations, and trending players.
 */

import { z } from "zod";
import { attribution, bullet, heading, separator } from "../format.js";
import { defineTool } from "../tool.js";
import type { Sport } from "../types.js";
import { SUPPORTED_SPORTS_DESCRIPTION, sportEnum } from "../types.js";

const getFantasyProjectionsParamsShape = {
  sport: sportEnum.describe(`Sport (${SUPPORTED_SPORTS_DESCRIPTION}).`),
  view: z
    .enum(["projections", "waiver", "trends"])
    .optional()
    .describe(
      "Which fantasy view: projections (default), waiver wire picks, or trending players.",
    ),
};

const GET_FANTASY_PROJECTIONS_NAME_VALUE = "get_fantasy_projections";
const GET_FANTASY_PROJECTIONS_DESCRIPTION_VALUE =
  "Get fantasy sports analytics — player projections, waiver wire recommendations, " +
  `and trending players. Supported sports: ${SUPPORTED_SPORTS_DESCRIPTION}. ` +
  "Useful for setting fantasy lineups, finding waiver adds, and spotting breakout players.";

function formatRecord(r: Record<string, unknown>): string {
  const name = (r.player_name ?? r.name ?? r.player ?? "Unknown") as string;
  const parts = [name];
  if (r.position) parts.push(r.position as string);
  if (r.team) parts.push(r.team as string);
  if (r.projected_fantasy_points != null)
    parts.push(`${Number(r.projected_fantasy_points).toFixed(1)} pts`);
  if (r.projected_points != null && r.projected_fantasy_points == null)
    parts.push(`${Number(r.projected_points).toFixed(1)} pts`);
  if (r.ownership_pct != null)
    parts.push(`${(Number(r.ownership_pct) * 100).toFixed(0)}% owned`);
  if (r.trend_direction)
    parts.push(`${r.trend_direction} (${r.trend_magnitude ?? "?"})`);
  return parts.join(" | ");
}

export const getFantasyProjectionsTool = defineTool({
  name: GET_FANTASY_PROJECTIONS_NAME_VALUE,
  description: GET_FANTASY_PROJECTIONS_DESCRIPTION_VALUE,
  params: getFantasyProjectionsParamsShape,
  handler: async (ctx, input) => {
    const client = ctx.client;
    const view = input.view ?? "projections";
    const sport = input.sport as Sport;

    if (view === "waiver") {
      const data = await client.getFantasyWaiver(sport);
      const adds = data.add_targets ?? [];
      const drops = data.drop_candidates ?? [];
      if (!adds.length && !drops.length) {
        return `No waiver wire data available for ${input.sport.toUpperCase()}.`;
      }
      const lines = [
        heading(`Waiver Wire — ${input.sport.toUpperCase()}`) + separator(),
      ];
      if (adds.length) {
        lines.push(heading("  ADD TARGETS"));
        for (const p of adds.slice(0, 10))
          lines.push(`    + ${formatRecord(p)}`);
      }
      if (drops.length) {
        lines.push(heading("  DROP CANDIDATES"));
        for (const p of drops.slice(0, 10))
          lines.push(`    - ${formatRecord(p)}`);
      }
      lines.push(separator() + attribution());
      return lines.join("\n");
    }

    if (view === "trends") {
      const data = await client.getFantasyTrends(sport);
      const up = data.trending_up ?? [];
      const down = data.trending_down ?? [];
      if (!up.length && !down.length) {
        return `No trending player data available for ${input.sport.toUpperCase()}.`;
      }
      const lines = [
        heading(`Fantasy Trends — ${input.sport.toUpperCase()} (last 7 days)`) +
          separator(),
      ];
      if (up.length) {
        lines.push(heading("  TRENDING UP"));
        for (const p of up.slice(0, 10)) lines.push(`    ↑ ${formatRecord(p)}`);
      }
      if (down.length) {
        lines.push(heading("  TRENDING DOWN"));
        for (const p of down.slice(0, 10))
          lines.push(`    ↓ ${formatRecord(p)}`);
      }
      lines.push(separator() + attribution());
      return lines.join("\n");
    }

    // Default: projections
    const data = await client.getFantasyProjections(sport);
    const projections = data.projections ?? [];
    if (!projections.length) {
      return `No fantasy projections available for ${input.sport.toUpperCase()}.`;
    }
    const lines = [
      heading(
        `Fantasy Projections — ${input.sport.toUpperCase()} (${projections.length} player${projections.length === 1 ? "" : "s"})`,
      ) + separator(),
    ];
    for (const p of projections.slice(0, 20))
      lines.push(bullet([formatRecord(p)]));
    if (projections.length > 20)
      lines.push(bullet([`... and ${projections.length - 20} more`]));
    lines.push(separator() + attribution());
    return lines.join("\n");
  },
});
